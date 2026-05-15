// backend/src/services/hybrid.search.service.ts
// Updated Day 22: OpenTelemetry spans + search cache + metrics

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
import type { RerankerService } from "./reranker.service"
import type { RerankedResult } from "../types/retrieval.types"
import { retrievalRequests, retrievalLatency } from "../utils/metrics"
import { getTracer } from "../telemetry/tracer"
import { withSpan, RAG_ATTRS, DB_ATTRS } from "../telemetry/spans"
import { searchCache } from "../cache/index"

const RRF_K = 60
const NOT_IN_LIST_RANK = 999

export class HybridSearchService {
  private readonly vectorSearchService: VectorSearchService
  private readonly keywordSearchService: KeywordSearchService
  private readonly tracer = getTracer("hybrid.search.service")

  constructor(
    prisma: PrismaClient,
    private readonly embeddingService: EmbeddingService
  ) {
    this.vectorSearchService = new VectorSearchService(prisma)
    this.keywordSearchService = new KeywordSearchService(prisma)
  }

  async search(
    query: string,
    options: Partial<HybridSearchOptions> = {}
  ): Promise<HybridSearchResult[]> {
    return withSpan(this.tracer, "retrieval.hybridSearch", async span => {
      span.setAttribute(RAG_ATTRS.QUERY, query.slice(0, 200))
      span.setAttribute(RAG_ATTRS.STRATEGY, "hybrid")
      span.setAttribute(DB_ATTRS.SYSTEM, "postgresql")

      if (!query || query.trim() === "") return []

      const topK = options.topK ?? 10
      const minSimilarity = options.minSimilarity ?? 0.0
      const documentIds = options.documentIds ?? []
      const userId = options.userId

      // ── Cache check ─────────────────────────────────────────────────
      if (userId) {
        const cached = await searchCache.get(query, userId, topK, documentIds)
        if (cached !== null) {
          span.setAttribute(RAG_ATTRS.CACHE_HIT, true)
          return cached
        }
      }

      const timer = retrievalLatency.startTimer()
      const start = Date.now()

      retrievalRequests.inc({ strategy: "hybrid" })

      // ── Embed the query ─────────────────────────────────────────────
      const queryVector = await this.embeddingService.embedText(query, "RETRIEVAL_QUERY")

      // ── Run both searches in parallel ───────────────────────────────
      const searchOptions = { topK: topK * 2, documentIds, userId }

      const [vectorResults, keywordResults] = await Promise.all([
        withSpan(this.tracer, "retrieval.vectorSearch", async vs => {
          vs.setAttribute(DB_ATTRS.OPERATION, "cosine_similarity")
          vs.setAttribute("retrieval.topK", topK * 2)
          return this.vectorSearchService.search(queryVector, {
            ...searchOptions,
            minSimilarity,
          })
        }),
        withSpan(this.tracer, "retrieval.keywordSearch", async ks => {
          ks.setAttribute(DB_ATTRS.OPERATION, "tsvector_search")
          ks.setAttribute("retrieval.topK", topK * 2)
          return this.keywordSearchService.search(query, searchOptions)
        }),
      ])

      // ── RRF merge ───────────────────────────────────────────────────
      const merged = this.reciprocalRankFusion(vectorResults, keywordResults, topK)

      timer()

      logRagEvent("retrieve", "Hybrid search complete", {
        service: "HybridSearchService",
        chunkCount: merged.length,
        durationMs: Date.now() - start,
      })

      // ── Store in cache ──────────────────────────────────────────────
      if (userId) {
        await searchCache.set(query, userId, topK, merged, documentIds)
      }

      span.setAttribute(RAG_ATTRS.CHUNKS_RETRIEVED, merged.length)
      span.setAttribute("retrieval.vector_results", vectorResults.length)
      span.setAttribute("retrieval.keyword_results", keywordResults.length)

      return merged
    })
  }

  // ── reciprocalRankFusion (unchanged) ──────────────────────────────────
  private reciprocalRankFusion(
    vectorResults: VectorSearchResult[],
    keywordResults: KeywordSearchResult[],
    topK: number
  ): HybridSearchResult[] {
    const scoreMap = new Map<string, HybridSearchResult>()

    vectorResults.forEach((result, vectorRank) => {
      const rrfContribution = 1 / (RRF_K + vectorRank + 1)
      scoreMap.set(result.chunk.id, {
        chunk: result.chunk,
        vectorRank: vectorRank,
        keywordRank: NOT_IN_LIST_RANK,
        rrfScore: rrfContribution,
      })
    })

    keywordResults.forEach((result, keywordRank) => {
      const rrfContribution = 1 / (RRF_K + keywordRank + 1)
      const existing = scoreMap.get(result.chunk.id)

      if (existing !== undefined) {
        existing.keywordRank = keywordRank
        existing.rrfScore += rrfContribution
      } else {
        scoreMap.set(result.chunk.id, {
          chunk: result.chunk,
          vectorRank: NOT_IN_LIST_RANK,
          keywordRank: keywordRank,
          rrfScore: rrfContribution,
        })
      }
    })

    return Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, topK)
  }

  // ── toCitations (unchanged) ───────────────────────────────────────────
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

  // ── compareStrategies (unchanged) ─────────────────────────────────────
  async compareStrategies(
    query: string,
    options: Partial<HybridSearchOptions> = {}
  ): Promise<{
    query: string
    vectorOnly: VectorSearchResult[]
    keywordOnly: KeywordSearchResult[]
    hybrid: HybridSearchResult[]
    onlyInVector: string[]
    onlyInKeyword: string[]
    inBoth: string[]
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

  // ── searchAndRerank (unchanged) ───────────────────────────────────────
  async searchAndRerank(
    query: string,
    rerankerService: RerankerService,
    options: Partial<HybridSearchOptions> = {}
  ): Promise<RerankedResult[]> {
    const topK = options.topK ?? 10

    const hybridResults = await this.search(query, {
      ...options,
      topK: topK * 2,
    })

    if (hybridResults.length === 0) return []

    const reranked = await rerankerService.rerank(query, hybridResults, {
      topK,
      minRerankScore: 0.0,
    })

    logRagEvent("rerank", "Search + rerank complete", {
      service: "HybridSearchService",
      chunkCount: reranked.length,
    })

    return reranked
  }
}
