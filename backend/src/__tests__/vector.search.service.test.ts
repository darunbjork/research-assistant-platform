// backend/src/__tests__/vector.search.service.test.ts
// Tests for VectorSearchService – updated for 3072‑dim embeddings (gemini-embedding-001)

import { VectorSearchService } from "../services/vector.search.service"
import type { PrismaClient } from "@prisma/client"

// ── Test Fixtures (updated to 3072 dimensions) ───────────────────────────
const VALID_3072_VECTOR = Array(3072).fill(0.1) as number[]
const WRONG_DIM_VECTOR = Array(512).fill(0.1) as number[]
const NAN_VECTOR = Array(3072).fill(NaN) as number[]
const INF_VECTOR = Array(3072).fill(Infinity) as number[]
const EMPTY_VECTOR: number[] = []

// A realistic fake chunk row – matches pgvector return shape
function makeFakeChunkRow(
  overrides: Partial<{
    id: string
    documentId: string
    content: string
    chunkIndex: number
    tokenCount: number
    source: string
    pageNumber: number | null
    chunkingStrategy: string
    createdAt: Date
    cosine_distance: number
  }> = {}
): object {
  return {
    id: "chunk-abc-123",
    documentId: "doc-xyz-456",
    content: "Machine learning enables systems to learn from data.",
    chunkIndex: 0,
    tokenCount: 12,
    source: "ml-intro.txt",
    pageNumber: null,
    chunkingStrategy: "recursive",
    createdAt: new Date("2026-04-27T10:00:00Z"),
    cosine_distance: 0.15, // 1 - 0.15 = 0.85 similarity
    ...overrides,
  }
}

// ── Mock PrismaClient Factory ─────────────────────────────────────────────
function makeMockPrisma(
  fakeRows: object[] = [makeFakeChunkRow()]
): jest.Mocked<Pick<PrismaClient, "$queryRaw">> {
  return {
    $queryRaw: jest.fn().mockResolvedValue(fakeRows),
  } as unknown as jest.Mocked<Pick<PrismaClient, "$queryRaw">>
}

describe("VectorSearchService", () => {
  let service: VectorSearchService
  let mockPrisma: jest.Mocked<Pick<PrismaClient, "$queryRaw">>

  beforeEach(() => {
    mockPrisma = makeMockPrisma()
    service = new VectorSearchService(mockPrisma as unknown as PrismaClient)
  })

  // ── Input Validation ───────────────────────────────────────────────────
  describe("search() — input validation", () => {
    it("throws for an empty vector", async () => {
      await expect(service.search(EMPTY_VECTOR)).rejects.toThrow(
        "Query vector must be a non-empty array"
      )
    })

    it("throws for wrong dimensions (512 instead of 3072)", async () => {
      await expect(service.search(WRONG_DIM_VECTOR)).rejects.toThrow(
        "Query vector must have 3072 dimensions. Received: 512."
      )
    })

    it("includes the received dimension count in the error message", async () => {
      await expect(service.search(WRONG_DIM_VECTOR)).rejects.toThrow("Received: 512")
    })

    it("throws for a vector containing NaN", async () => {
      await expect(service.search(NAN_VECTOR)).rejects.toThrow(
        "Query vector contains NaN or Infinity values"
      )
    })

    it("throws for a vector containing Infinity", async () => {
      await expect(service.search(INF_VECTOR)).rejects.toThrow(
        "Query vector contains NaN or Infinity values"
      )
    })

    it("does NOT call the database when validation fails", async () => {
      await expect(service.search(EMPTY_VECTOR)).rejects.toThrow()
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
    })
  })

  // ── Happy Path ─────────────────────────────────────────────────────────
  describe("search() — happy path", () => {
    it("returns an array when given a valid 3072‑dim vector", async () => {
      const results = await service.search(VALID_3072_VECTOR)
      expect(Array.isArray(results)).toBe(true)
    })

    it("returns the same number of results as the database returned", async () => {
      const fakeRows = [
        makeFakeChunkRow({ id: "chunk-1", cosine_distance: 0.1 }),
        makeFakeChunkRow({ id: "chunk-2", cosine_distance: 0.2 }),
        makeFakeChunkRow({ id: "chunk-3", cosine_distance: 0.3 }),
      ]
      mockPrisma = makeMockPrisma(fakeRows)
      service = new VectorSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search(VALID_3072_VECTOR)
      expect(results).toHaveLength(3)
    })

    it("returns empty array when database returns no results", async () => {
      mockPrisma = makeMockPrisma([])
      service = new VectorSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search(VALID_3072_VECTOR)
      expect(results).toHaveLength(0)
    })

    it("calls the database exactly once per search", async () => {
      await service.search(VALID_3072_VECTOR)
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
    })

    it("returns results in the same order as the database (ascending distance)", async () => {
      const fakeRows = [
        makeFakeChunkRow({ id: "chunk-a", cosine_distance: 0.05 }),
        makeFakeChunkRow({ id: "chunk-b", cosine_distance: 0.2 }),
        makeFakeChunkRow({ id: "chunk-c", cosine_distance: 0.45 }),
      ]
      mockPrisma = makeMockPrisma(fakeRows)
      service = new VectorSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search(VALID_3072_VECTOR)
      expect(results[0]?.chunk.id).toBe("chunk-a")
      expect(results[1]?.chunk.id).toBe("chunk-b")
      expect(results[2]?.chunk.id).toBe("chunk-c")
    })
  })

  // ── Result Shape ───────────────────────────────────────────────────────
  describe("search() — result shape", () => {
    it("each result has a chunk object", async () => {
      const results = await service.search(VALID_3072_VECTOR)
      results.forEach(result => expect(result.chunk).toBeDefined())
    })

    it("each result has a cosineSimilarity between 0 and 1", async () => {
      const results = await service.search(VALID_3072_VECTOR)
      results.forEach(result => {
        expect(result.cosineSimilarity).toBeGreaterThanOrEqual(0)
        expect(result.cosineSimilarity).toBeLessThanOrEqual(1)
      })
    })

    it("converts cosine distance to similarity correctly (1 - distance)", async () => {
      const results = await service.search(VALID_3072_VECTOR)
      expect(results[0]?.cosineSimilarity).toBeCloseTo(0.85, 2)
    })

    it("assigns sequential rank values starting at 0", async () => {
      const fakeRows = [
        makeFakeChunkRow({ id: "a" }),
        makeFakeChunkRow({ id: "b" }),
        makeFakeChunkRow({ id: "c" }),
      ]
      mockPrisma = makeMockPrisma(fakeRows)
      service = new VectorSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search(VALID_3072_VECTOR)
      expect(results[0]?.rank).toBe(0)
      expect(results[1]?.rank).toBe(1)
      expect(results[2]?.rank).toBe(2)
    })

    it("each chunk has all required fields", async () => {
      const results = await service.search(VALID_3072_VECTOR)
      const chunk = results[0]?.chunk

      expect(chunk).toBeDefined()
      if (chunk) {
        expect(typeof chunk.id).toBe("string")
        expect(typeof chunk.documentId).toBe("string")
        expect(typeof chunk.content).toBe("string")
        expect(typeof chunk.chunkIndex).toBe("number")
        expect(typeof chunk.tokenCount).toBe("number")
        expect(typeof chunk.source).toBe("string")
        expect(chunk.createdAt).toBeInstanceOf(Date)
      }
    })

    it("clamps negative similarity values to 0", async () => {
      const fakeRows = [makeFakeChunkRow({ cosine_distance: 1.1 })]
      mockPrisma = makeMockPrisma(fakeRows)
      service = new VectorSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search(VALID_3072_VECTOR)
      expect(results[0]?.cosineSimilarity).toBeGreaterThanOrEqual(0)
    })

    it("handles null pageNumber correctly", async () => {
      const fakeRows = [makeFakeChunkRow({ pageNumber: null })]
      mockPrisma = makeMockPrisma(fakeRows)
      service = new VectorSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search(VALID_3072_VECTOR)
      expect(results[0]?.chunk.pageNumber).toBeNull()
    })

    it("handles numeric pageNumber correctly", async () => {
      const fakeRows = [makeFakeChunkRow({ pageNumber: 7 })]
      mockPrisma = makeMockPrisma(fakeRows)
      service = new VectorSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search(VALID_3072_VECTOR)
      expect(results[0]?.chunk.pageNumber).toBe(7)
    })
  })

  // ── Search Options ─────────────────────────────────────────────────────
  describe("search() — options", () => {
    it("passes without error when topK is specified", async () => {
      await expect(service.search(VALID_3072_VECTOR, { topK: 5 })).resolves.toBeDefined()
    })

    it("passes without error when minSimilarity is specified", async () => {
      await expect(service.search(VALID_3072_VECTOR, { minSimilarity: 0.7 })).resolves.toBeDefined()
    })

    it("passes without error when documentIds are specified", async () => {
      await expect(
        service.search(VALID_3072_VECTOR, { documentIds: ["doc-1", "doc-2"] })
      ).resolves.toBeDefined()
    })

    it("passes without error when userId is specified", async () => {
      await expect(service.search(VALID_3072_VECTOR, { userId: "user-123" })).resolves.toBeDefined()
    })

    it("uses all-chunks query when no filters are specified", async () => {
      await service.search(VALID_3072_VECTOR)
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
    })
  })

  // ── Index Stats ────────────────────────────────────────────────────────
  describe("getIndexStats()", () => {
    it("returns indexExists: true when index row is returned", async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ indexname: "idx_document_chunk_embedding" }])
        .mockResolvedValueOnce([{ count: BigInt(42) }])

      const stats = await service.getIndexStats()
      expect(stats.indexExists).toBe(true)
    })

    it("returns indexExists: false when no index row is returned", async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: BigInt(0) }])

      const stats = await service.getIndexStats()
      expect(stats.indexExists).toBe(false)
    })

    it("returns the correct total chunk count", async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ indexname: "idx_document_chunk_embedding" }])
        .mockResolvedValueOnce([{ count: BigInt(1337) }])

      const stats = await service.getIndexStats()
      expect(stats.totalChunks).toBe(1337)
    })

    it("returns null indexName when index does not exist", async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: BigInt(0) }])

      const stats = await service.getIndexStats()
      expect(stats.indexName).toBeNull()
    })
  })

  // ── Error Handling ─────────────────────────────────────────────────────
  describe("search() — error handling", () => {
    it("propagates database errors to the caller", async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(
        new Error("pgvector: index is not ready for scanning")
      )
      await expect(service.search(VALID_3072_VECTOR)).rejects.toThrow(
        "pgvector: index is not ready for scanning"
      )
    })

    it("propagates errors even when options are provided", async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(new Error("connection refused"))
      await expect(service.search(VALID_3072_VECTOR, { userId: "user-123" })).rejects.toThrow(
        "connection refused"
      )
    })
  })
})
