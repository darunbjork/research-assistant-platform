// backend/src/repositories/chunk.repository.ts
// Handles all database operations for the DocumentChunk table.
//
// THIS IS THE MOST IMPORTANT REPOSITORY IN THE PROJECT.
// It is where vectors are stored and later retrieved.
//
// WHY RAW SQL FOR VECTOR OPERATIONS:
// Prisma does not natively support pgvector's vector(768) type.
// We use Prisma.$executeRaw for INSERT (to write vectors)
// and Prisma.$queryRaw for SELECT with <=> cosine distance operator.
// All other queries use normal Prisma — only vector columns need raw SQL.

import type { PrismaClient } from "@prisma/client"
import type { ChunkMetadata } from "../types"
import { logRagEvent } from "../utils/logger"
import { indexedChunks } from "../utils/metrics"

// ── Types ─────────────────────────────────────────────────────────────────

// A chunk ready to be stored — content + vector + metadata
export interface ChunkToStore {
  content: string
  chunkIndex: number
  tokenCount: number
  embedding: number[] // 768-dimensional vector
  metadata: ChunkMetadata
}

// A stored chunk row returned from the database
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

// Result of a vector similarity search — stored chunk + its similarity score
export interface SimilarChunk extends StoredChunk {
  cosineSimilarity: number // 0-1, higher = more similar
}

export class ChunkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ── Store Many Chunks ─────────────────────────────────────────────────
  // Stores all chunks for a document in one transaction.
  // If any chunk fails to store, the entire batch is rolled back.
  // This prevents partial ingestion (some chunks stored, others not).
  //
  // WHY RAW SQL HERE:
  // We need to insert a vector(768) column.
  // Prisma.create() does not know how to format this type.
  // $executeRaw lets us write: embedding = $1::vector
  // where $1 is the JavaScript number[] formatted as [0.1,0.2,...]
  async storeMany(documentId: string, chunks: ChunkToStore[]): Promise<number> {
    if (chunks.length === 0) return 0

    const start = Date.now()

    // Prisma.$transaction runs all queries atomically.
    // Either ALL chunks are stored, or NONE are.
    // This prevents partial ingestion.
    await this.prisma.$transaction(
      chunks.map(
        chunk =>
          // $executeRaw: writes a single row with the vector column
          // The ::vector cast tells PostgreSQL to interpret the string as a vector type
          this.prisma.$executeRaw`
          INSERT INTO "DocumentChunk" (
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
            ${`[${chunk.embedding.join(",")}]`}::vector,
            ${chunk.metadata.source},
            ${chunk.metadata.pageNumber ?? null},
            ${chunk.metadata.chunkingStrategy},
            NOW()
          )
        `
      )
    )

    // Update the Prometheus gauge: how many total chunks are now in pgvector?
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

  // ── Count for Document ────────────────────────────────────────────────
  async countForDocument(documentId: string): Promise<number> {
    return this.prisma.documentChunk.count({
      where: { documentId },
    })
  }

  // ── Delete for Document ───────────────────────────────────────────────
  // Called when a document is deleted — removes all its chunks from pgvector.
  // (The Prisma schema also has onDelete: Cascade, but we call this explicitly
  //  so we can update the Prometheus gauge after deletion.)
  async deleteForDocument(documentId: string): Promise<void> {
    await this.prisma.documentChunk.deleteMany({
      where: { documentId },
    })

    const totalCount = await this.prisma.documentChunk.count()
    indexedChunks.set(totalCount)
  }

  // ── List for Document ─────────────────────────────────────────────────
  // Returns all chunks for a document — useful for debugging and admin views.
  // Does NOT return the embedding vector (it's 768 numbers — too large for lists).
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

  // ── Get Total Count ───────────────────────────────────────────────────
  async getTotalCount(): Promise<number> {
    return this.prisma.documentChunk.count()
  }
}
