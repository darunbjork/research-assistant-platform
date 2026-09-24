import Bull from "bull"
import type Redis from "ioredis"
import { ChunkingService } from "../services/chunking.service"
import { EmbeddingService } from "../services/embedding.service"
import { DocumentRepository } from "../repositories/document.repository"
import { ChunkRepository } from "../repositories/chunk.repository"
import { PrismaClient } from "@prisma/client"
import { logRagEvent, logError } from "../utils/logger"
import { indexedDocuments } from "../utils/metrics"
import type { ChunkToStore } from "../repositories/chunk.repository"

export interface IngestionJobData {
  name: string
  content: string
  mimeType: string
  sizeBytes: number
  userId: string
  requestId: string
}
export interface IngestionJobResult {
  documentId: string
  name: string
  chunkCount: number
  tokenCount: number
  durationMs: number
}

const PROGRESS = {
  STARTED: 5,
  CHUNKED: 33,
  EMBEDDED: 66,
  STORED: 90,
  COMPLETE: 100,
} as const

const QUEUE_NAME = "document-ingestion"
const CONCURRENCY = 3
const MAX_ATTEMPTS = 3
const BACKOFF_DELAY_MS = 5_000

let prismaInstance: PrismaClient | null = null
let redisInstance: Redis | null = null

function getPrisma(): PrismaClient {
  if (!prismaInstance) prismaInstance = new PrismaClient()
  return prismaInstance
}

export function createIngestionQueue(redisClient: Redis): Bull.Queue<IngestionJobData> {
  redisInstance = redisClient

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"

  const queue = new Bull<IngestionJobData>(QUEUE_NAME, {
    redis: redisUrl,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: BACKOFF_DELAY_MS,
      },
      removeOnComplete: 50,
      removeOnFail: 20,
    },
  })

  queue.process(CONCURRENCY, async (job: Bull.Job<IngestionJobData>) => {
    return processIngestionJob(job)
  })

  queue.on("completed", (_job: Bull.Job<IngestionJobData>, result: IngestionJobResult) => {
    logRagEvent("ingest", "Ingestion job completed", {
      service: "IngestionQueue",
      documentId: result.documentId,
      chunkCount: result.chunkCount,
      durationMs: result.durationMs,
    })
    indexedDocuments.inc()
  })

  queue.on("failed", (job: Bull.Job<IngestionJobData>, error: Error) => {
    logError("Ingestion job failed", error, {
      service: "IngestionQueue",
      userId: job.data.userId,
      name: job.data.name,
    })
  })

  queue.on("stalled", (job: Bull.Job<IngestionJobData>) => {
    logRagEvent("ingest", "Ingestion job stalled — will retry", {
      service: "IngestionQueue",
      userId: job.data.userId,
    })
  })

  logRagEvent("ingest", "Ingestion queue ready", {
    service: "IngestionQueue",
    concurrency: CONCURRENCY,
  })

  return queue
}

async function processIngestionJob(job: Bull.Job<IngestionJobData>): Promise<IngestionJobResult> {
  const { name, content, mimeType, sizeBytes, userId } = job.data
  const start = Date.now()

  await job.progress(PROGRESS.STARTED)

  logRagEvent("ingest", "Processing ingestion job", {
    service: "IngestionQueue",
    userId,
    name,
  })

  const prisma = getPrisma()
  const chunkingService = new ChunkingService()
  const embeddingService = new EmbeddingService(
    process.env.GEMINI_API_KEY ?? "",
    redisInstance! // Redis instance is set when queue is created
  )
  const documentRepository = new DocumentRepository(prisma)
  const chunkRepository = new ChunkRepository(prisma)

  let document
  try {
    document = await documentRepository.create({ name, content, mimeType, sizeBytes }, userId)
  } catch (error: unknown) {
    logError("Job: document creation failed", error, {
      service: "IngestionQueue",
      userId,
    })
    throw error // Bull retries on throw
  }

  const documentId = document.id

  try {
    const rawChunks = chunkingService.chunk(content, "recursive", {
      maxChunkSize: 512,
      overlap: 50,
    })

    if (rawChunks.length === 0) {
      throw new Error("Document produced zero chunks — content may be empty")
    }

    await job.progress(PROGRESS.CHUNKED)

    logRagEvent("chunk", "Job: chunking complete", {
      service: "IngestionQueue",
      documentId,
      chunkCount: rawChunks.length,
    })

    const chunkTexts = rawChunks.map(c => c.content)
    const embeddings = await embeddingService.embedBatch(chunkTexts, "RETRIEVAL_DOCUMENT")

    await job.progress(PROGRESS.EMBEDDED)

    logRagEvent("embed", "Job: embedding complete", {
      service: "IngestionQueue",
      documentId,
      chunkCount: rawChunks.length,
    })

    const chunksToStore: ChunkToStore[] = rawChunks.map((rawChunk, index) => {
      const embedding = embeddings[index]
      if (embedding === undefined) {
        throw new Error(`Missing embedding for chunk ${index}`)
      }
      return {
        content: rawChunk.content,
        chunkIndex: rawChunk.chunkIndex,
        tokenCount: rawChunk.tokenCount,
        embedding,
        metadata: {
          source: name,
          chunkingStrategy: "recursive",
          characterCount: rawChunk.characterCount,
          pageNumber: undefined,
        },
      }
    })

    await chunkRepository.storeMany(documentId, chunksToStore)
    await job.progress(PROGRESS.STORED)

    const totalTokens = rawChunks.reduce((sum, c) => sum + c.tokenCount, 0)
    const durationMs = Date.now() - start

    await job.progress(PROGRESS.COMPLETE)

    const result: IngestionJobResult = {
      documentId,
      name,
      chunkCount: rawChunks.length,
      tokenCount: totalTokens,
      durationMs,
    }

    logRagEvent("ingest", "Job: ingestion complete", {
      service: "IngestionQueue",
      documentId,
      chunkCount: rawChunks.length,
      durationMs,
    })

    return result
  } catch (error: unknown) {
    try {
      await chunkRepository.deleteForDocument(documentId)
      await documentRepository.deleteForUser(documentId, userId)
    } catch (cleanupErr: unknown) {
      logError("Job: cleanup after failure also failed", cleanupErr, {
        service: "IngestionQueue",
        documentId,
      })
    }

    logError("Job: ingestion pipeline failed", error, {
      service: "IngestionQueue",
      documentId,
      userId,
    })

    throw error
  }
}
export interface JobStatus {
  jobId: string
  status: "waiting" | "active" | "completed" | "failed" | "delayed" | "unknown"
  progress: number // 0-100
  result?: IngestionJobResult
  error?: string
  createdAt: number
  finishedAt?: number
}

export async function getJobStatus(
  queue: Bull.Queue<IngestionJobData>,
  jobId: string
): Promise<JobStatus | null> {
  const job = await queue.getJob(jobId)
  if (!job) return null

  const state = await job.getState()
  const progress = typeof job.progress() === "number" ? (job.progress() as number) : 0
  const failedReason = job.failedReason

  return {
    jobId,
    status: state as JobStatus["status"],
    progress: progress,
    result: state === "completed" ? (job.returnvalue as IngestionJobResult) : undefined,
    error: state === "failed" ? failedReason : undefined,
    createdAt: job.timestamp,
    finishedAt: job.finishedOn ?? undefined,
  }
}
