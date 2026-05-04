// backend/src/services/keyword.search.service.ts
// Performs BM25-style keyword search using PostgreSQL's built-in
// full-text search (tsvector / tsquery).
//
// WHY POSTGRESQL FULL-TEXT SEARCH INSTEAD OF ELASTICSEARCH:
// PostgreSQL's tsvector has been production-grade since 2006.
// For a RAG system with < 1 million chunks, it is more than sufficient.
// No extra infrastructure. No extra cost. Same database you already have.
//
// HOW POSTGRESQL FULL-TEXT SEARCH WORKS:
//
// INDEXING SIDE (done at query time — no pre-processing needed):
//   to_tsvector('english', content)
//   → strips stop words ("the", "a", "is")
//   → stems words ("running" → "run", "machines" → "machin")
//   → produces a weighted word list for fast lookup
//
// QUERY SIDE:
//   plainto_tsquery('english', 'machine learning')
//   → produces tsquery: 'machin' & 'learn'
//   → finds chunks containing both stemmed forms
//
// RANKING:
//   ts_rank(to_tsvector(content), query)
//   → scores based on term frequency, position, and document length
//   → this is an approximation of BM25

import type { PrismaClient } from "@prisma/client"
import type { KeywordSearchResult, KeywordSearchOptions, ChunkSearchResult } from "../types"
import { logRagEvent, logError } from "../utils/logger"
import { retrievalRequests } from "../utils/metrics"

// ── Raw row returned by PostgreSQL full-text search ───────────────────────
interface RawKeywordSearchRow {
  id: string
  documentId: string
  content: string
  chunkIndex: number
  tokenCount: number
  source: string
  pageNumber: number | null
  chunkingStrategy: string
  createdAt: Date
  rank: number // ts_rank score — higher = more keyword matches
}

export class KeywordSearchService {
  constructor(private readonly prisma: PrismaClient) {}

  // ── search ────────────────────────────────────────────────────────────
  // Finds chunks containing the query terms using PostgreSQL full-text search.
  // Returns results ordered by BM25-style rank score (highest first).
  async search(
    query: string,
    options: Partial<KeywordSearchOptions> = {}
  ): Promise<KeywordSearchResult[]> {
    if (!query || query.trim().length === 0) {
      return []
    }

    const topK = options.topK ?? 10
    const documentIds = options.documentIds ?? []
    const userId = options.userId

    const start = Date.now()
    retrievalRequests.inc({ strategy: "keyword" })

    try {
      // Sanitise the query:
      // Remove special characters that would break tsquery syntax.
      // plainto_tsquery handles phrase-like queries gracefully.
      const sanitisedQuery = query
        .trim()
        .replace(/[^\w\s]/g, " ")
        .trim()

      if (sanitisedQuery.length === 0) {
        return []
      }

      let results: RawKeywordSearchRow[]

      if (documentIds.length > 0) {
        // Restrict to specific documents
        results = await this.prisma.$queryRaw<RawKeywordSearchRow[]>`
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
            ts_rank(
              to_tsvector('english', dc.content),
              plainto_tsquery('english', ${sanitisedQuery})
            ) AS rank
          FROM "DocumentChunk" dc
          WHERE dc."documentId" = ANY(${documentIds}::text[])
            AND to_tsvector('english', dc.content)
                @@ plainto_tsquery('english', ${sanitisedQuery})
          ORDER BY rank DESC
          LIMIT ${topK}
        `
      } else if (userId !== undefined) {
        // Restrict to user's own documents via JOIN
        results = await this.prisma.$queryRaw<RawKeywordSearchRow[]>`
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
            ts_rank(
              to_tsvector('english', dc.content),
              plainto_tsquery('english', ${sanitisedQuery})
            ) AS rank
          FROM "DocumentChunk" dc
          INNER JOIN "Document" d ON d.id = dc."documentId"
          WHERE d."userId" = ${userId}
            AND to_tsvector('english', dc.content)
                @@ plainto_tsquery('english', ${sanitisedQuery})
          ORDER BY rank DESC
          LIMIT ${topK}
        `
      } else {
        // Search all chunks
        results = await this.prisma.$queryRaw<RawKeywordSearchRow[]>`
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
            ts_rank(
              to_tsvector('english', dc.content),
              plainto_tsquery('english', ${sanitisedQuery})
            ) AS rank
          FROM "DocumentChunk" dc
          WHERE to_tsvector('english', dc.content)
                @@ plainto_tsquery('english', ${sanitisedQuery})
          ORDER BY rank DESC
          LIMIT ${topK}
        `
      }

      const searchResults = this.toKeywordSearchResults(results)

      logRagEvent("retrieve", "Keyword search complete", {
        service: "KeywordSearchService",
        chunkCount: searchResults.length,
        durationMs: Date.now() - start,
      })

      return searchResults
    } catch (error: unknown) {
      logError("Keyword search failed", error, {
        service: "KeywordSearchService",
      })
      throw error
    }
  }

  // ── Private: Convert raw rows to typed results ────────────────────────
  private toKeywordSearchResults(rows: RawKeywordSearchRow[]): KeywordSearchResult[] {
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
        bm25Score: Number(row.rank),
        rank: index,
      }
    })
  }
}
