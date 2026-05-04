// backend/src/services/vector.search.service.ts
// Performs semantic similarity search against pgvector.
//
// THE SINGLE RESPONSIBILITY OF THIS SERVICE:
// Given a query vector (768 numbers), find the N most similar
// chunk vectors stored in the DocumentChunk table.
//
// WHAT IT DOES NOT DO:
//   - It does not embed the query (EmbeddingService does that)
//   - It does not rank results (RerankerService does that, Day 17)
//   - It does not merge with keyword results (HybridSearchService, Day 10)
//   - It does not generate an answer (GenerationService, Day 11)
//
// Each step is its own service. Each service is testable in isolation.
// This is the Single Responsibility Principle applied to RAG.

import type { PrismaClient } from "@prisma/client"
import type { VectorSearchResult, VectorSearchOptions, ChunkSearchResult } from "../types"
import { logRagEvent, logError } from "../utils/logger"
import { retrievalRequests, retrievalLatency } from "../utils/metrics"

// ── The raw shape returned by Prisma.$queryRaw ────────────────────────────
// Prisma returns plain objects from raw queries — we must type them manually.
// Every column name maps to a JavaScript field with the exact Postgres type.
interface RawVectorSearchRow {
  id: string
  documentId: string
  content: string
  chunkIndex: number // Postgres integer → number
  tokenCount: number
  source: string
  pageNumber: number | null
  chunkingStrategy: string
  createdAt: Date
  cosine_distance: number // 1 - similarity (pgvector <=> result)
}

export class VectorSearchService {
  // Default IVFFlat probe count — how many clusters to search.
  // Can be overridden per-query for accuracy vs speed tradeoff.
  private readonly defaultProbes = 10

  constructor(private readonly prisma: PrismaClient) {}

  // ── search ────────────────────────────────────────────────────────────
  // The main entry point.
  // queryVector: the embedded form of the user's question
  // options: topK, minSimilarity, optional document/user filters
  async search(
    queryVector: number[],
    options: Partial<VectorSearchOptions> = {}
  ): Promise<VectorSearchResult[]> {
    // Validate the vector before sending to pgvector
    this.validateVector(queryVector)

    const topK = options.topK ?? 10
    const minSimilarity = options.minSimilarity ?? 0.0
    const documentIds = options.documentIds ?? []
    const userId = options.userId

    const timer = retrievalLatency.startTimer()
    const start = Date.now()

    retrievalRequests.inc({ strategy: "vector" })

    try {
      // Format the query vector as a PostgreSQL vector literal: [0.1,0.2,...]
      // pgvector expects this exact format for the <=> operator
      const vectorLiteral = `[${queryVector.join(",")}]`

      // ── The Core pgvector Query ────────────────────────────────────────
      // SELECT ... ORDER BY embedding <=> $vector LIMIT N
      //
      // embedding <=> $vector computes the cosine DISTANCE (0-2 range).
      // 1 - cosine_distance = cosine SIMILARITY (0-1 range).
      //
      // We SELECT (1 - cosine_distance) AS similarity, then filter
      // on similarity >= minSimilarity for quality control.
      //
      // The WHERE clause optionally restricts to specific documents or users.
      // This is how data isolation works at the search level.
      let results: RawVectorSearchRow[]

      if (documentIds.length > 0) {
        // Restrict search to specific document IDs
        results = await this.prisma.$queryRaw<RawVectorSearchRow[]>`
          SET LOCAL ivfflat.probes = ${this.defaultProbes};

          SELECT
            dc.id,
            dc."documentId",
            dc.content,
            dc."chunkIndex",
            dc."tokenCount",
            dc.source,
            dc."pageNumber",
            dc."chunkingStrategy",
            dc."createdAt",
            (dc.embedding <=> ${vectorLiteral}::vector) AS cosine_distance
          FROM "DocumentChunk" dc
          WHERE dc."documentId" = ANY(${documentIds}::text[])
            AND (1 - (dc.embedding <=> ${vectorLiteral}::vector)) >= ${minSimilarity}
          ORDER BY dc.embedding <=> ${vectorLiteral}::vector
          LIMIT ${topK}
        `
      } else if (userId !== undefined) {
        // Restrict search to documents owned by this user
        // JOIN with Document table to check userId — data isolation
        results = await this.prisma.$queryRaw<RawVectorSearchRow[]>`
          SELECT
            dc.id,
            dc."documentId",
            dc.content,
            dc."chunkIndex",
            dc."tokenCount",
            dc.source,
            dc."pageNumber",
            dc."chunkingStrategy",
            dc."createdAt",
            (dc.embedding <=> ${vectorLiteral}::vector) AS cosine_distance
          FROM "DocumentChunk" dc
          INNER JOIN "Document" d ON d.id = dc."documentId"
          WHERE d."userId" = ${userId}
            AND (1 - (dc.embedding <=> ${vectorLiteral}::vector)) >= ${minSimilarity}
          ORDER BY dc.embedding <=> ${vectorLiteral}::vector
          LIMIT ${topK}
        `
      } else {
        // Search all chunks (development/admin use only)
        results = await this.prisma.$queryRaw<RawVectorSearchRow[]>`
          SELECT
            dc.id,
            dc."documentId",
            dc.content,
            dc."chunkIndex",
            dc."tokenCount",
            dc.source,
            dc."pageNumber",
            dc."chunkingStrategy",
            dc."createdAt",
            (dc.embedding <=> ${vectorLiteral}::vector) AS cosine_distance
          FROM "DocumentChunk" dc
          WHERE (1 - (dc.embedding <=> ${vectorLiteral}::vector)) >= ${minSimilarity}
          ORDER BY dc.embedding <=> ${vectorLiteral}::vector
          LIMIT ${topK}
        `
      }

      // Convert raw rows to typed VectorSearchResult objects
      const searchResults = this.toVectorSearchResults(results)

      logRagEvent("retrieve", "Vector search complete", {
        service: "VectorSearchService",
        chunkCount: searchResults.length,
        durationMs: Date.now() - start,
      })

      return searchResults
    } catch (error: unknown) {
      logError("Vector search failed", error, {
        service: "VectorSearchService",
      })
      throw error
    } finally {
      timer()
    }
  }

  // ── searchSimilarToChunk ──────────────────────────────────────────────
  // Find chunks that are similar to an EXISTING chunk (not a query).
  // Use case: "Show me more chunks like this one"
  // This is useful for debugging retrieval quality.
  async searchSimilarToChunk(
    chunkId: string,
    options: Partial<VectorSearchOptions> = {}
  ): Promise<VectorSearchResult[]> {
    const topK = (options.topK ?? 5) + 1 // +1 because the chunk itself will appear

    // First, fetch the existing chunk's embedding
    const rows = await this.prisma.$queryRaw<Array<{ embedding: string }>>`
      SELECT embedding::text FROM "DocumentChunk" WHERE id = ${chunkId}
    `

    const firstRow = rows[0]
    if (firstRow === undefined) {
      throw new Error(`Chunk ${chunkId} not found`)
    }

    // Parse the vector string "[0.1,0.2,...]" back to number[]
    const embeddingStr = firstRow.embedding.replace("[", "").replace("]", "")
    const queryVector = embeddingStr.split(",").map(Number)

    // Search using the chunk's own vector
    const results = await this.search(queryVector, { ...options, topK })

    // Exclude the chunk itself from results (it would have similarity 1.0)
    return results.filter(r => r.chunk.id !== chunkId)
  }

  // ── explainSimilarity ─────────────────────────────────────────────────
  // Development utility: show the similarity score between a query and a specific chunk.
  // Use this to debug why a chunk is or is not being retrieved.
  async explainSimilarity(
    queryVector: number[],
    chunkId: string
  ): Promise<{ chunkId: string; similarity: number; content: string } | null> {
    this.validateVector(queryVector)

    const vectorLiteral = `[${queryVector.join(",")}]`

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string
        content: string
        cosine_distance: number
      }>
    >`
      SELECT
        id,
        content,
        (embedding <=> ${vectorLiteral}::vector) AS cosine_distance
      FROM "DocumentChunk"
      WHERE id = ${chunkId}
    `

    const row = rows[0]
    if (row === undefined) return null

    return {
      chunkId: row.id,
      similarity: 1 - row.cosine_distance,
      content: row.content,
    }
  }

  // ── getIndexStats ─────────────────────────────────────────────────────
  // Check whether the IVFFlat index exists.
  // Call this from the /health endpoint or admin dashboard.
  async getIndexStats(): Promise<{
    indexExists: boolean
    totalChunks: number
    indexName: string | null
  }> {
    const indexRows = await this.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'DocumentChunk'
        AND indexname = 'idx_document_chunk_embedding'
    `

    const totalRows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM "DocumentChunk"
    `

    const firstRow = totalRows[0]
    const totalChunks = firstRow !== undefined ? Number(firstRow.count) : 0

    return {
      indexExists: indexRows.length > 0,
      totalChunks,
      indexName: indexRows[0]?.indexname ?? null,
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  // Convert raw Prisma query results to typed VectorSearchResult objects.
  // cosine_distance (from pgvector) ranges 0-2 for cosine distance.
  // We convert: similarity = 1 - cosine_distance → ranges 0-1.
  private toVectorSearchResults(rows: RawVectorSearchRow[]): VectorSearchResult[] {
    return rows.map((row, index) => {
      const chunk: ChunkSearchResult = {
        id: row.id,
        documentId: row.documentId,
        content: row.content,
        chunkIndex: Number(row.chunkIndex),
        tokenCount: Number(row.tokenCount),
        source: row.source,
        pageNumber: row.pageNumber !== null ? Number(row.pageNumber) : null,
        chunkingStrategy: row.chunkingStrategy,
        createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
      }

      return {
        chunk,
        cosineSimilarity: Math.max(0, 1 - Number(row.cosine_distance)),
        rank: index,
      }
    })
  }

  // Validates a vector before sending to pgvector.
  // Guards against: empty arrays, wrong dimensions, NaN/Infinity values.
  private validateVector(vector: number[]): void {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Query vector must be a non-empty array")
    }

    // Updated to 3072 dimensions for gemini-embedding-001
    if (vector.length !== 3072) {
      throw new Error(
        `Query vector must have 3072 dimensions. Received: ${vector.length}. ` +
          `Make sure you are using the same embedding model as when indexing documents (gemini-embedding-001).`
      )
    }

    const hasInvalid = vector.some(v => !Number.isFinite(v))
    if (hasInvalid) {
      throw new Error(
        "Query vector contains NaN or Infinity values. " +
          "This usually means the embedding API returned invalid data."
      )
    }
  }
}
