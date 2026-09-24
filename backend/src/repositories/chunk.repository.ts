import type { PrismaClient } from "@prisma/client"
import type { ChunkMetadata } from "../types"
import { logRagEvent } from "../utils/logger"
import { indexedChunks } from "../utils/metrics"
export interface ChunkToStore {
  content: string
  chunkIndex: number
  tokenCount: number
  embedding: number[]
  metadata: ChunkMetadata
}

export interface StoredChunk {
  id: string
  documentId: string
  content: string
  chunkIndex: number
  tokenCount: number
  source: string
  pageNumber: number | null
  chunkingStrategy: string
  createdAt: Date
}
export interface SimilarChunk extends StoredChunk {
  cosineSimilarity: number
}

export class ChunkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async storeMany(documentId: string, chunks: ChunkToStore[]): Promise<number> {
    if (chunks.length === 0) return 0

    const start = Date.now()

    await this.prisma.$transaction(
      chunks.map(chunk => {
        let embeddingArray: number[]

        if (Array.isArray(chunk.embedding)) {
          embeddingArray = chunk.embedding
        } else if (
          typeof chunk.embedding === "object" &&
          chunk.embedding !== null &&
          "vector" in chunk.embedding
        ) {
          embeddingArray = (chunk.embedding as { vector: number[] }).vector
        } else if (typeof chunk.embedding === "string") {
          try {
            embeddingArray = JSON.parse(chunk.embedding)
          } catch {
            throw new Error("Invalid embedding format: string parsing failed")
          }
        } else {
          throw new Error("Invalid embedding format: unexpected type")
        }

        if (!Array.isArray(embeddingArray)) {
          throw new Error("Invalid embedding format: resulting embedding is not an array")
        }

        return this.prisma.$executeRaw`
          INSERT INTO "document_chunks" (
            id,
            "documentId",
            content,
            "chunkIndex",
            "tokenCount",
            embedding,
            source,
            "pageNumber",
            "chunkingStrategy",
            "createdAt"
          ) VALUES (
            gen_random_uuid()::text,
            ${documentId},
            ${chunk.content},
            ${chunk.chunkIndex},
            ${chunk.tokenCount},
            ${`[${embeddingArray.join(",")}]`}::vector,
            ${chunk.metadata.source},
            ${chunk.metadata.pageNumber ?? null},
            ${chunk.metadata.chunkingStrategy},
            NOW()
          )
        `
      })
    )

    const totalCount = await this.prisma.documentChunk.count()
    indexedChunks.set(totalCount)

    logRagEvent("ingest", "Chunks stored in pgvector", {
      service: "ChunkRepository",
      documentId,
      chunkCount: chunks.length,
      durationMs: Date.now() - start,
    })

    return chunks.length
  }

  async countForDocument(documentId: string): Promise<number> {
    return this.prisma.documentChunk.count({
      where: { documentId },
    })
  }

  async deleteForDocument(documentId: string): Promise<void> {
    await this.prisma.documentChunk.deleteMany({
      where: { documentId },
    })

    const totalCount = await this.prisma.documentChunk.count()
    indexedChunks.set(totalCount)
  }

  async listForDocument(documentId: string): Promise<StoredChunk[]> {
    const chunks = await this.prisma.documentChunk.findMany({
      where: { documentId },
      orderBy: { chunkIndex: "asc" },
      select: {
        id: true,
        documentId: true,
        content: true,
        chunkIndex: true,
        tokenCount: true,
        source: true,
        pageNumber: true,
        chunkingStrategy: true,
        createdAt: true,
      },
    })

    return chunks
  }

  async getTotalCount(): Promise<number> {
    return this.prisma.documentChunk.count()
  }
}
