// backend/src/__tests__/hybrid.search.service.test.ts
// Tests for HybridSearchService — focusing on the RRF algorithm.
//
// WHAT WE TEST HERE:
// 1. The RRF math is correct (scores are computed as per the formula)
// 2. Chunks in BOTH lists rank higher than chunks in only ONE list
// 3. Results are deduplicated (no chunk appears twice)
// 4. The parallel execution path works correctly
// 5. Edge cases: one list empty, both lists empty, complete overlap

import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import type { VectorSearchResult, KeywordSearchResult, ChunkSearchResult } from "../types"

// ── Mock Factories ────────────────────────────────────────────────────────

function makeMockEmbeddingService(): jest.Mocked<EmbeddingService> {
  return {
    embedText: jest.fn().mockResolvedValue(Array(3072).fill(0.1) as number[]),
    embedBatch: jest.fn().mockResolvedValue([Array(3072).fill(0.1) as number[]]),
    getCacheStats: jest.fn().mockReturnValue({ hits: 0, misses: 0, hitRate: 0 }),
  } as unknown as jest.Mocked<EmbeddingService>
}

// A realistic fake chunk row for pgvector queries (vector search)
function makeVectorRow(id: string, cosine_distance: number): object {
  return {
    id,
    documentId: "doc-001",
    content: `Content of chunk ${id}`,
    chunkIndex: 0,
    tokenCount: 20,
    source: "test.txt",
    pageNumber: null,
    chunkingStrategy: "recursive",
    createdAt: new Date(),
    cosine_distance,
  }
}

// A realistic fake chunk row for keyword search queries
function makeKeywordRow(id: string, rank: number): object {
  return {
    id,
    documentId: "doc-001",
    content: `Content of chunk ${id}`,
    chunkIndex: 0,
    tokenCount: 20,
    source: "test.txt",
    pageNumber: null,
    chunkingStrategy: "recursive",
    createdAt: new Date(),
    rank,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("HybridSearchService", () => {
  let service: HybridSearchService
  let mockPrisma: jest.Mocked<Pick<PrismaClient, "$queryRaw">>
  let mockEmbedding: jest.Mocked<EmbeddingService>

  beforeEach(() => {
    mockEmbedding = makeMockEmbeddingService()

    // Default mock: vector search returns chunk-A and chunk-B
    //               keyword search returns chunk-B and chunk-C
    // chunk-B appears in BOTH — should rank highest after RRF
    mockPrisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          // first call = vector search
          makeVectorRow("chunk-A", 0.1), // similarity 0.90 — rank 0
          makeVectorRow("chunk-B", 0.2), // similarity 0.80 — rank 1
        ])
        .mockResolvedValueOnce([
          // second call = keyword search
          makeKeywordRow("chunk-B", 0.9), // rank 0
          makeKeywordRow("chunk-C", 0.7), // rank 1
        ]),
    } as unknown as jest.Mocked<Pick<PrismaClient, "$queryRaw">>

    service = new HybridSearchService(mockPrisma as unknown as PrismaClient, mockEmbedding)
  })

  // ── Empty queries ──────────────────────────────────────────────────────
  describe("search() — empty queries", () => {
    it("returns empty array for empty string", async () => {
      const results = await service.search("")
      expect(results).toHaveLength(0)
    })

    it("returns empty array for whitespace string", async () => {
      const results = await service.search("   ")
      expect(results).toHaveLength(0)
    })

    it("does not call embedText for empty query", async () => {
      await service.search("")
      expect(mockEmbedding.embedText).not.toHaveBeenCalled()
    })
  })

  // ── RRF Algorithm ─────────────────────────────────────────────────────
  describe("reciprocalRankFusion — the core algorithm", () => {
    it("chunk-B (in BOTH lists) ranks higher than chunk-A (vector only)", async () => {
      const results = await service.search("test query")

      const chunkAIndex = results.findIndex(r => r.chunk.id === "chunk-A")
      const chunkBIndex = results.findIndex(r => r.chunk.id === "chunk-B")

      expect(chunkAIndex).toBeGreaterThan(-1) // chunk-A is in results
      expect(chunkBIndex).toBeGreaterThan(-1) // chunk-B is in results
      expect(chunkBIndex).toBeLessThan(chunkAIndex)
      // chunk-B should have a lower index (higher rank) because it appears in BOTH lists
    })

    it("chunk-B (in BOTH lists) has a higher rrfScore than chunk-A (vector only)", async () => {
      const results = await service.search("test query")

      const chunkA = results.find(r => r.chunk.id === "chunk-A")
      const chunkB = results.find(r => r.chunk.id === "chunk-B")

      expect(chunkA?.rrfScore).toBeDefined()
      expect(chunkB?.rrfScore).toBeDefined()

      if (chunkA && chunkB) {
        expect(chunkB.rrfScore).toBeGreaterThan(chunkA.rrfScore)
      }
    })

    it("chunk-C (keyword only) appears in the merged results", async () => {
      const results = await service.search("test query")
      const chunkC = results.find(r => r.chunk.id === "chunk-C")
      expect(chunkC).toBeDefined()
    })

    it("all three unique chunks appear in the merged results", async () => {
      const results = await service.search("test query")
      const ids = results.map(r => r.chunk.id)

      expect(ids).toContain("chunk-A")
      expect(ids).toContain("chunk-B")
      expect(ids).toContain("chunk-C")
    })

    it("no chunk appears twice (deduplication)", async () => {
      const results = await service.search("test query")
      const ids = results.map(r => r.chunk.id)
      const unique = new Set(ids)

      expect(unique.size).toBe(ids.length)
    })

    it("results are sorted by rrfScore descending", async () => {
      const results = await service.search("test query")

      for (let i = 0; i < results.length - 1; i++) {
        const current = results[i]?.rrfScore ?? 0
        const next = results[i + 1]?.rrfScore ?? 0
        expect(current).toBeGreaterThanOrEqual(next)
      }
    })

    it("chunk in BOTH lists has correct vectorRank and keywordRank", async () => {
      const results = await service.search("test query")
      const chunkB = results.find(r => r.chunk.id === "chunk-B")

      expect(chunkB?.vectorRank).toBe(1) // rank 1 in vector list (0-indexed)
      expect(chunkB?.keywordRank).toBe(0) // rank 0 in keyword list
    })

    it("chunk only in vector list has keywordRank of 999", async () => {
      const results = await service.search("test query")
      const chunkA = results.find(r => r.chunk.id === "chunk-A")

      expect(chunkA?.keywordRank).toBe(999)
    })

    it("chunk only in keyword list has vectorRank of 999", async () => {
      const results = await service.search("test query")
      const chunkC = results.find(r => r.chunk.id === "chunk-C")

      expect(chunkC?.vectorRank).toBe(999)
    })

    it("RRF score for rank-0 chunk is approximately 1/61", async () => {
      // RRF formula: 1 / (k + rank + 1) = 1 / (60 + 0 + 1) = 1/61 ≈ 0.01639
      // chunk-A is rank 0 in vector, not in keyword:
      //   rrfScore = 1/61 ≈ 0.01639
      const results = await service.search("test query")
      const chunkA = results.find(r => r.chunk.id === "chunk-A")

      expect(chunkA?.rrfScore).toBeCloseTo(1 / 61, 4)
    })

    it("RRF score for chunk in both lists is sum of both contributions", async () => {
      // chunk-B: rank 1 in vector, rank 0 in keyword
      //   rrfScore = 1/(60+1+1) + 1/(60+0+1)
      //            = 1/62 + 1/61
      //            ≈ 0.01613 + 0.01639
      //            ≈ 0.03252
      const results = await service.search("test query")
      const chunkB = results.find(r => r.chunk.id === "chunk-B")
      const expected = 1 / 62 + 1 / 61

      expect(chunkB?.rrfScore).toBeCloseTo(expected, 4)
    })
  })

  // ── Edge cases (using spyOn on the internal services) ─────────────────────
  describe("search() — edge cases", () => {
    let service: HybridSearchService
    let mockPrisma: jest.Mocked<Pick<PrismaClient, "$queryRaw">>
    let mockEmbedding: jest.Mocked<EmbeddingService>

    // Helper: create a valid ChunkSearchResult for mock data
    function makeMockChunk(id: string): ChunkSearchResult {
      return {
        id,
        documentId: "doc-001",
        content: `Content of chunk ${id}`,
        chunkIndex: 0,
        tokenCount: 20,
        source: "test.txt",
        pageNumber: null,
        chunkingStrategy: "recursive",
        createdAt: new Date(),
      }
    }

    // Helper: create a typed VectorSearchResult
    function makeMockVectorResult(
      id: string,
      cosineSimilarity: number,
      rank: number
    ): VectorSearchResult {
      return {
        chunk: makeMockChunk(id),
        cosineSimilarity,
        rank,
      }
    }

    // Helper: create a typed KeywordSearchResult
    function makeMockKeywordResult(
      id: string,
      bm25Score: number,
      rank: number
    ): KeywordSearchResult {
      return {
        chunk: makeMockChunk(id),
        bm25Score,
        rank,
      }
    }

    beforeEach(() => {
      mockEmbedding = makeMockEmbeddingService()
      mockPrisma = {
        $queryRaw: jest.fn(),
      } as unknown as jest.Mocked<Pick<PrismaClient, "$queryRaw">>
      service = new HybridSearchService(mockPrisma as unknown as PrismaClient, mockEmbedding)
    })

    it("works when vector search returns no results", async () => {
      const vectorSpy = jest.spyOn(service["vectorSearchService"], "search").mockResolvedValue([])
      const keywordSpy = jest
        .spyOn(service["keywordSearchService"], "search")
        .mockResolvedValue([makeMockKeywordResult("chunk-K", 0.9, 0)])

      mockEmbedding.embedText.mockResolvedValue(Array(3072).fill(0.1))

      const results = await service.search("test")
      expect(results).toHaveLength(1)
      expect(results[0]?.chunk.id).toBe("chunk-K")

      vectorSpy.mockRestore()
      keywordSpy.mockRestore()
    })

    it("works when keyword search returns no results", async () => {
      const vectorSpy = jest
        .spyOn(service["vectorSearchService"], "search")
        .mockResolvedValue([makeMockVectorResult("chunk-V", 0.85, 0)])
      const keywordSpy = jest.spyOn(service["keywordSearchService"], "search").mockResolvedValue([])

      mockEmbedding.embedText.mockResolvedValue(Array(3072).fill(0.1))

      const results = await service.search("test")
      expect(results).toHaveLength(1)
      expect(results[0]?.chunk.id).toBe("chunk-V")

      vectorSpy.mockRestore()
      keywordSpy.mockRestore()
    })

    it("works when both searches return empty results", async () => {
      jest.spyOn(service["vectorSearchService"], "search").mockResolvedValue([])
      jest.spyOn(service["keywordSearchService"], "search").mockResolvedValue([])
      mockEmbedding.embedText.mockResolvedValue(Array(3072).fill(0.1))

      const results = await service.search("test")
      expect(results).toHaveLength(0)
    })

    it("respects topK limit", async () => {
      const manyVectorResults = Array.from({ length: 10 }, (_, i) =>
        makeMockVectorResult(`v-${i}`, 1 - i * 0.05, i)
      )
      const manyKeywordResults = Array.from({ length: 10 }, (_, i) =>
        makeMockKeywordResult(`k-${i}`, 1 - i * 0.1, i)
      )

      jest.spyOn(service["vectorSearchService"], "search").mockResolvedValue(manyVectorResults)
      jest.spyOn(service["keywordSearchService"], "search").mockResolvedValue(manyKeywordResults)
      mockEmbedding.embedText.mockResolvedValue(Array(3072).fill(0.1))

      const results = await service.search("test", { topK: 5 })
      expect(results.length).toBeLessThanOrEqual(5)
    })

    it("handles complete overlap (all chunks in both lists)", async () => {
      const sharedVectorResults = [
        makeMockVectorResult("shared-1", 0.9, 0),
        makeMockVectorResult("shared-2", 0.8, 1),
      ]
      const sharedKeywordResults = [
        makeMockKeywordResult("shared-1", 0.9, 0),
        makeMockKeywordResult("shared-2", 0.7, 1),
      ]

      jest.spyOn(service["vectorSearchService"], "search").mockResolvedValue(sharedVectorResults)
      jest.spyOn(service["keywordSearchService"], "search").mockResolvedValue(sharedKeywordResults)
      mockEmbedding.embedText.mockResolvedValue(Array(3072).fill(0.1))

      const results = await service.search("test")
      // Only 2 unique chunks, not 4
      expect(results).toHaveLength(2)
      // Both should have contributions from both lists
      results.forEach(result => {
        expect(result.vectorRank).not.toBe(999)
        expect(result.keywordRank).not.toBe(999)
      })
    })
  }) // ── Embedding calls ────────────────────────────────────────────────────
  describe("search() — embedding", () => {
    it("calls embedText with RETRIEVAL_QUERY task type", async () => {
      await service.search("test query")

      expect(mockEmbedding.embedText).toHaveBeenCalledWith("test query", "RETRIEVAL_QUERY")
    })

    it("calls embedText exactly once per search", async () => {
      await service.search("test query")
      expect(mockEmbedding.embedText).toHaveBeenCalledTimes(1)
    })
  })

  // ── toCitations ───────────────────────────────────────────────────────
  describe("toCitations()", () => {
    it("converts hybrid results to Citation objects", async () => {
      const results = await service.search("test query")
      const citations = service.toCitations(results)

      citations.forEach(citation => {
        expect(typeof citation.chunkId).toBe("string")
        expect(typeof citation.documentId).toBe("string")
        expect(typeof citation.documentName).toBe("string")
        expect(typeof citation.excerpt).toBe("string")
        expect(typeof citation.relevanceScore).toBe("number")
      })
    })

    it("excerpt is capped at 200 characters with ellipsis", async () => {
      const longContent = "A".repeat(300)
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([makeVectorRow("long-chunk", 0.1)])
        .mockResolvedValueOnce([])

      // Override the content in the mock
      const rowWithLongContent = {
        ...makeVectorRow("long-chunk", 0.1),
        content: longContent,
      }
      mockPrisma.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([rowWithLongContent])
        .mockResolvedValueOnce([])

      service = new HybridSearchService(mockPrisma as unknown as PrismaClient, mockEmbedding)

      const results = await service.search("test")
      const citations = service.toCitations(results)

      expect(citations[0]?.excerpt).toHaveLength(203) // 200 chars + "..."
      expect(citations[0]?.excerpt.endsWith("...")).toBe(true)
    })

    it("returns same number of citations as results", async () => {
      const results = await service.search("test query")
      const citations = service.toCitations(results)
      expect(citations).toHaveLength(results.length)
    })
  })
})
