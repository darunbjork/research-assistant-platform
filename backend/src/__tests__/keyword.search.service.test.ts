// backend/src/__tests__/keyword.search.service.test.ts

import { KeywordSearchService } from "../services/keyword.search.service"
import type { PrismaClient } from "@prisma/client"

// ── Fixtures ──────────────────────────────────────────────────────────────
function makeFakeKeywordRow(
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
    rank: number
  }> = {}
): object {
  return {
    id: "chunk-kw-001",
    documentId: "doc-001",
    content: "Machine learning enables systems to learn from data.",
    chunkIndex: 0,
    tokenCount: 10,
    source: "ml-intro.txt",
    pageNumber: null,
    chunkingStrategy: "recursive",
    createdAt: new Date(),
    rank: 0.0759, // typical ts_rank value
    ...overrides,
  }
}

function makeMockPrisma(
  fakeRows: object[] = [makeFakeKeywordRow()]
): jest.Mocked<Pick<PrismaClient, "$queryRaw">> {
  return {
    $queryRaw: jest.fn().mockResolvedValue(fakeRows),
  } as unknown as jest.Mocked<Pick<PrismaClient, "$queryRaw">>
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("KeywordSearchService", () => {
  let service: KeywordSearchService
  let mockPrisma: jest.Mocked<Pick<PrismaClient, "$queryRaw">>

  beforeEach(() => {
    mockPrisma = makeMockPrisma()
    service = new KeywordSearchService(mockPrisma as unknown as PrismaClient)
  })

  // ── Empty / invalid queries ────────────────────────────────────────────
  describe("search() — empty / invalid queries", () => {
    it("returns empty array for empty string", async () => {
      const results = await service.search("")
      expect(results).toHaveLength(0)
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
    })

    it("returns empty array for whitespace-only string", async () => {
      const results = await service.search("   ")
      expect(results).toHaveLength(0)
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
    })

    it("returns empty array when database finds no keyword matches", async () => {
      mockPrisma = makeMockPrisma([])
      service = new KeywordSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search("xylophone quantum")
      expect(results).toHaveLength(0)
    })
  })

  // ── Happy path ─────────────────────────────────────────────────────────
  describe("search() — happy path", () => {
    it("returns results for a matching query", async () => {
      const results = await service.search("machine learning")
      expect(results.length).toBeGreaterThan(0)
    })

    it("calls the database exactly once", async () => {
      await service.search("machine learning")
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
    })

    it("each result has a chunk and a bm25Score", async () => {
      const results = await service.search("machine learning")

      results.forEach(result => {
        expect(result.chunk).toBeDefined()
        expect(typeof result.bm25Score).toBe("number")
      })
    })

    it("bm25Score is non-negative", async () => {
      const results = await service.search("machine learning")
      results.forEach(result => {
        expect(result.bm25Score).toBeGreaterThanOrEqual(0)
      })
    })

    it("rank values are sequential starting from 0", async () => {
      const fakeRows = [
        makeFakeKeywordRow({ id: "a", rank: 0.9 }),
        makeFakeKeywordRow({ id: "b", rank: 0.7 }),
        makeFakeKeywordRow({ id: "c", rank: 0.4 }),
      ]
      mockPrisma = makeMockPrisma(fakeRows)
      service = new KeywordSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search("test query")
      expect(results[0]?.rank).toBe(0)
      expect(results[1]?.rank).toBe(1)
      expect(results[2]?.rank).toBe(2)
    })

    it("returns correct number of results", async () => {
      const fakeRows = Array.from({ length: 5 }, (_, i) => makeFakeKeywordRow({ id: `chunk-${i}` }))
      mockPrisma = makeMockPrisma(fakeRows)
      service = new KeywordSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search("test")
      expect(results).toHaveLength(5)
    })
  })

  // ── Result shape ───────────────────────────────────────────────────────
  describe("search() — result shape", () => {
    it("chunk has all required fields", async () => {
      const results = await service.search("machine")
      const chunk = results[0]?.chunk

      if (chunk) {
        expect(typeof chunk.id).toBe("string")
        expect(typeof chunk.content).toBe("string")
        expect(typeof chunk.documentId).toBe("string")
        expect(typeof chunk.chunkIndex).toBe("number")
        expect(typeof chunk.tokenCount).toBe("number")
        expect(typeof chunk.source).toBe("string")
        expect(chunk.createdAt).toBeInstanceOf(Date)
      }
    })

    it("handles null pageNumber correctly", async () => {
      const results = await service.search("machine")
      expect(results[0]?.chunk.pageNumber).toBeNull()
    })

    it("handles numeric pageNumber correctly", async () => {
      mockPrisma = makeMockPrisma([makeFakeKeywordRow({ pageNumber: 5 })])
      service = new KeywordSearchService(mockPrisma as unknown as PrismaClient)

      const results = await service.search("machine")
      expect(results[0]?.chunk.pageNumber).toBe(5)
    })
  })

  // ── Options ────────────────────────────────────────────────────────────
  describe("search() — options", () => {
    it("accepts documentIds option without error", async () => {
      await expect(
        service.search("machine", { documentIds: ["doc-1", "doc-2"] })
      ).resolves.toBeDefined()
    })

    it("accepts userId option without error", async () => {
      await expect(service.search("machine", { userId: "user-123" })).resolves.toBeDefined()
    })

    it("accepts topK option without error", async () => {
      await expect(service.search("machine", { topK: 3 })).resolves.toBeDefined()
    })
  })

  // ── Error handling ─────────────────────────────────────────────────────
  describe("search() — error handling", () => {
    it("propagates database errors to the caller", async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(new Error("PostgreSQL connection lost"))

      await expect(service.search("machine")).rejects.toThrow("PostgreSQL connection lost")
    })
  })
})
