// backend/src/queue/ingestion.queue.ts
// Bull Queue for async document ingestion.
//
// ARCHITECTURE:
//
//   HTTP REQUEST SIDE (fast):
//     POST /api/v1/documents/ingest
//       → validate the document
//       → add a job to the queue: { name, content, mimeType, userId }
//       → return 202 Accepted with jobId
//     Total HTTP response time: < 50ms
//
//   WORKER SIDE (slow, runs in background):
//     Bull picks up the job from Redis
//       → ChunkingService.chunkRecursive()
//       → EmbeddingService.embedBatch()
//       → ChunkRepository.storeMany()
//     Updates job progress: 0% → 33% → 66% → 100%
//     Total worker time: 2-5 seconds
//
//   POLLING SIDE (user checks status):
//     GET /api/v1/documents/jobs/:jobId
//       → returns { status: "waiting" | "active" | "completed" | "failed", progress: 45 }
//
// BULL QUEUE FEATURES USED:
//   - concurrency: 3 workers run 3 jobs simultaneously
//   - attempts: failed jobs retry up to 3 times
//   - backoff: wait 5s before first retry, 30s before second
//   - progress: 0-100 progress tracking
//   - events: completed, failed, progress events

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

// ── Job Data Shape ────────────────────────────────────────────────────────
// What we put into the queue when a document is uploaded
export interface IngestionJobData {
  name: string
  content: string
  mimeType: string
  sizeBytes: number
  userId: string
  requestId: string // for tracing — links the HTTP request to the job
}

// ── Job Result Shape ──────────────────────────────────────────────────────
// What the worker returns when ingestion is complete
export interface IngestionJobResult {
  documentId: string
  name: string
  chunkCount: number
  tokenCount: number
  durationMs: number
}

// ── Progress Stages ───────────────────────────────────────────────────────
// Progress percentage at each stage (for UI progress bars)
const PROGRESS = {
  STARTED: 5,
  CHUNKED: 33,
  EMBEDDED: 66,
  STORED: 90,
  COMPLETE: 100,
} as const

// ── Queue Configuration ───────────────────────────────────────────────────
const QUEUE_NAME = "document-ingestion"
const CONCURRENCY = 3 // process 3 documents simultaneously
const MAX_ATTEMPTS = 3
const BACKOFF_DELAY_MS = 5_000 // 5 seconds between retries

// ── Singleton Services ────────────────────────────────────────────────────
// Shared across all worker executions within this process.
// Lazy-initialised to avoid circular dependencies.
let prismaInstance: PrismaClient | null = null
let redisInstance: Redis | null = null

function getPrisma(): PrismaClient {
  if (!prismaInstance) prismaInstance = new PrismaClient()
  return prismaInstance
}

// ── Create Queue ─────────────────────────────────────────────────────────
export function createIngestionQueue(redisClient: Redis): Bull.Queue<IngestionJobData> {
  redisInstance = redisClient

  // Bull accepts Redis connection options or a Redis URL string.
  // We pass the URL from .env so Bull creates its own connection.
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"

  const queue = new Bull<IngestionJobData>(QUEUE_NAME, {
    redis: redisUrl,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: BACKOFF_DELAY_MS,
      },
      removeOnComplete: 50, // keep last 50 completed jobs for status queries
      removeOnFail: 20, // keep last 20 failed jobs for debugging
    },
  })

  // ── Register the Worker ───────────────────────────────────────────────
  // This function runs in the background for every job picked from the queue.
  queue.process(CONCURRENCY, async (job: Bull.Job<IngestionJobData>) => {
    return processIngestionJob(job)
  })

  // ── Queue Events ──────────────────────────────────────────────────────
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

// ── Worker Function ───────────────────────────────────────────────────────
// This runs for every job. It mirrors what IngestionService.ingest() does
// but with progress tracking and Bull's retry support.
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

  // ── Step 1: Create the Document row ──────────────────────────────────
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
    // ── Step 2: Chunk the document ────────────────────────────────────
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

    // ── Step 3: Embed all chunks ──────────────────────────────────────
    const chunkTexts = rawChunks.map(c => c.content)
    const embeddings = await embeddingService.embedBatch(chunkTexts, "RETRIEVAL_DOCUMENT")

    await job.progress(PROGRESS.EMBEDDED)

    logRagEvent("embed", "Job: embedding complete", {
      service: "IngestionQueue",
      documentId,
      chunkCount: rawChunks.length,
    })

    // ── Step 4: Store chunks in pgvector ──────────────────────────────
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

    // ── Step 5: Complete ──────────────────────────────────────────────
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
    // Clean up the orphaned document if ingestion failed
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

    throw error // Bull retries on throw
  }
}

// ── Job Status Helper ──────────────────────────────────────────────────────
// Converts a Bull job to a clean status object for the API response.
export interface JobStatus {
  jobId: string
  status: "waiting" | "active" | "completed" | "failed" | "delayed" | "unknown"
  progress: number // 0-100
  result?: IngestionJobResult
  error?: string
  createdAt: number // Unix timestamp ms
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
