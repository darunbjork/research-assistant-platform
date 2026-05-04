// backend/src/services/hybrid.search.service.ts
// Combines vector search and keyword search into one ranked result list
// using Reciprocal Rank Fusion (RRF).
//
// THIS IS THE SERVICE THAT RETRIEVAL ACTUALLY CALLS.
// VectorSearchService and KeywordSearchService are NOT called directly
// by controllers or the agent — HybridSearchService orchestrates both.
//
// PIPELINE:
// 1. Run vector search and keyword search in PARALLEL (faster than sequential)
// 2. Merge the two ranked lists with RRF
// 3. Sort by RRF score descending
// 4. Return top-K results

import type { PrismaClient } from "@prisma/client"
import type { EmbeddingService } from "./embedding.service"
import { VectorSearchService } from "./vector.search.service"
import { KeywordSearchService } from "./keyword.search.service"
import type {
  HybridSearchResult,
  HybridSearchOptions,
  VectorSearchResult,
  KeywordSearchResult,
  Citation,
} from "../types"
import { logRagEvent } from "../utils/logger"
import { retrievalRequests, retrievalLatency } from "../utils/metrics"

// ── RRF Configuration ─────────────────────────────────────────────────────
// k = 60 is the standard smoothing constant from the original RRF paper.
// Higher k: results from both lists are weighted more equally.
// Lower k: results at the top of each list are weighted more heavily.
// Do not change this without benchmarking on your specific data.
const RRF_K = 60

// Sentinel rank for a document NOT appearing in a given list.
// A document only in the vector list gets keywordRank = 999.
// 1 / (60 + 999) ≈ 0.00094 — very small contribution.
const NOT_IN_LIST_RANK = 999

export class HybridSearchService {
  private readonly vectorSearchService: VectorSearchService
  private readonly keywordSearchService: KeywordSearchService

  constructor(
    prisma: PrismaClient,
    private readonly embeddingService: EmbeddingService
  ) {
    this.vectorSearchService = new VectorSearchService(prisma)
    this.keywordSearchService = new KeywordSearchService(prisma)
  }

  // ── search ────────────────────────────────────────────────────────────
  // Main entry point. Takes a plain text query, runs both search types,
  // merges with RRF, returns the top-K results.
  async search(
    query: string,
    options: Partial<HybridSearchOptions> = {}
  ): Promise<HybridSearchResult[]> {
    if (!query || query.trim().length === 0) {
      return []
    }

    const topK = options.topK ?? 10
    const minSimilarity = options.minSimilarity ?? 0.0
    const documentIds = options.documentIds ?? []
    const userId = options.userId

    const timer = retrievalLatency.startTimer()
    const start = Date.now()

    retrievalRequests.inc({ strategy: "hybrid" })

    // ── Step 1: Embed the query ───────────────────────────────────────
    // We embed with RETRIEVAL_QUERY task type — important for accuracy
    const queryVector = await this.embeddingService.embedText(query, "RETRIEVAL_QUERY")

    // ── Step 2: Run both searches in PARALLEL ─────────────────────────
    // Promise.all runs both at the same time instead of sequentially.
    // If vector search takes 20ms and keyword search takes 15ms:
    //   Sequential: 35ms total
    //   Parallel:   20ms total (the slower one determines the total)
    const searchOptions = { topK: topK * 2, documentIds, userId }

    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearchService.search(queryVector, {
        ...searchOptions,
        minSimilarity,
      }),
      this.keywordSearchService.search(query, searchOptions),
    ])

    // ── Step 3: Merge with Reciprocal Rank Fusion ─────────────────────
    const merged = this.reciprocalRankFusion(vectorResults, keywordResults, topK)

    timer()

    logRagEvent("retrieve", "Hybrid search complete", {
      service: "HybridSearchService",
      chunkCount: merged.length,
      durationMs: Date.now() - start,
    })

    return merged
  }

  // ── reciprocalRankFusion ──────────────────────────────────────────────
  // The core algorithm. Takes two ranked lists, produces one merged list.
  //
  // STEP BY STEP:
  // 1. For every chunk in the VECTOR results:
  //    rrfScore += 1 / (k + vectorRank)
  //
  // 2. For every chunk in the KEYWORD results:
  //    If already seen: rrfScore += 1 / (k + keywordRank)
  //    If new:          add new entry with rrfScore = 1 / (k + keywordRank)
  //
  // 3. Sort all entries by rrfScore descending.
  //
  // 4. Return the top topK entries.
  private reciprocalRankFusion(
    vectorResults: VectorSearchResult[],
    keywordResults: KeywordSearchResult[],
    topK: number
  ): HybridSearchResult[] {
    // Use a Map keyed by chunk ID to deduplicate across both lists.
    // One chunk can appear in both lists — the Map handles this naturally.
    const scoreMap = new Map<string, HybridSearchResult>()

    // ── Process vector results ─────────────────────────────────────────
    vectorResults.forEach((result, vectorRank) => {
      const rrfContribution = 1 / (RRF_K + vectorRank + 1)
      // +1 because ranks are 0-based but RRF formula expects 1-based

      scoreMap.set(result.chunk.id, {
        chunk: result.chunk,
        vectorRank: vectorRank,
        keywordRank: NOT_IN_LIST_RANK, // default: not in keyword results
        rrfScore: rrfContribution,
      })
    })

    // ── Process keyword results ───────────────────────────────────────
    keywordResults.forEach((result, keywordRank) => {
      const rrfContribution = 1 / (RRF_K + keywordRank + 1)
      const existing = scoreMap.get(result.chunk.id)

      if (existing !== undefined) {
        // Chunk appeared in BOTH lists — add the keyword contribution
        // This is the core of RRF: dual-list presence boosts the score
        existing.keywordRank = keywordRank
        existing.rrfScore += rrfContribution
      } else {
        // Chunk appeared ONLY in keyword results — create a new entry
        scoreMap.set(result.chunk.id, {
          chunk: result.chunk,
          vectorRank: NOT_IN_LIST_RANK,
          keywordRank: keywordRank,
          rrfScore: rrfContribution,
        })
      }
    })

    // ── Sort by RRF score and return top-K ────────────────────────────
    return Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, topK)
  }

  // ── toCitations ──────────────────────────────────────────────────────
  // Converts hybrid search results to the Citation format used by
  // GenerationService (Day 11) and the frontend citation cards.
  toCitations(results: HybridSearchResult[]): Citation[] {
    return results.map(result => ({
      chunkId: result.chunk.id,
      documentId: result.chunk.documentId,
      documentName: result.chunk.source,
      pageNumber: result.chunk.pageNumber ?? undefined,
      excerpt:
        result.chunk.content.slice(0, 200) + (result.chunk.content.length > 200 ? "..." : ""),
      relevanceScore: result.rrfScore,
    }))
  }

  // ── compareStrategies ─────────────────────────────────────────────────
  // Development utility: run all three strategies and compare their results.
  // Call this from a script to understand when hybrid beats either alone.
  // Returns a structured comparison report.
  async compareStrategies(
    query: string,
    options: Partial<HybridSearchOptions> = {}
  ): Promise<{
    query: string
    vectorOnly: VectorSearchResult[]
    keywordOnly: KeywordSearchResult[]
    hybrid: HybridSearchResult[]
    onlyInVector: string[] // chunk IDs only vector found
    onlyInKeyword: string[] // chunk IDs only keyword found
    inBoth: string[] // chunk IDs both found
  }> {
    const topK = options.topK ?? 5
    const userId = options.userId
    const documentIds = options.documentIds ?? []

    const queryVector = await this.embeddingService.embedText(query, "RETRIEVAL_QUERY")

    const [vectorOnly, keywordOnly, hybrid] = await Promise.all([
      this.vectorSearchService.search(queryVector, { topK, userId, documentIds }),
      this.keywordSearchService.search(query, { topK, userId, documentIds }),
      this.search(query, { topK, userId, documentIds }),
    ])

    const vectorIds = new Set(vectorOnly.map(r => r.chunk.id))
    const keywordIds = new Set(keywordOnly.map(r => r.chunk.id))

    return {
      query,
      vectorOnly,
      keywordOnly,
      hybrid,
      onlyInVector: [...vectorIds].filter(id => !keywordIds.has(id)),
      onlyInKeyword: [...keywordIds].filter(id => !vectorIds.has(id)),
      inBoth: [...vectorIds].filter(id => keywordIds.has(id)),
    }
  }
}
