// backend/src/__tests__/rag.service.test.ts
// Comprehensive tests for RagService — the top-level RAG orchestrator.

import { RagService } from "../services/rag.service"
import {
  makeMockHybridSearchService,
  makeMockGenerationService,
  makeHybridSearchResult,
} from "./helpers/mock-factories"

describe("RagService", () => {
  let service: RagService
  let mockHybrid: ReturnType<typeof makeMockHybridSearchService>
  let mockGen: ReturnType<typeof makeMockGenerationService>

  beforeEach(() => {
    mockHybrid = makeMockHybridSearchService([makeHybridSearchResult()])
    mockGen = makeMockGenerationService()
    service = new RagService(mockHybrid, mockGen)
  })

  // ── query() — happy path ───────────────────────────────────────────────
  describe("query() — happy path", () => {
    it("returns a RagResult with all required fields", async () => {
      const result = await service.query("What is ML?")

      expect(typeof result.answer).toBe("string")
      expect(Array.isArray(result.citations)).toBe(true)
      expect(typeof result.chunksRetrieved).toBe("number")
      expect(typeof result.chunksUsed).toBe("number")
      expect(typeof result.tokensUsed).toBe("number")
      expect(typeof result.model).toBe("string")
      expect(typeof result.durationMs).toBe("number")
      expect(typeof result.retrievalMs).toBe("number")
      expect(typeof result.generationMs).toBe("number")
    })

    it("calls hybridSearch with the user query", async () => {
      await service.query("What is ML?", { userId: "user-1" })

      expect(mockHybrid.search).toHaveBeenCalledWith(
        "What is ML?",
        expect.objectContaining({ userId: "user-1" })
      )
    })

    it("calls generation after retrieval", async () => {
      await service.query("What is ML?")

      expect(mockGen.generate).toHaveBeenCalledTimes(1)
    })

    it("passes retrieved chunks to generation", async () => {
      const chunk = makeHybridSearchResult({ content: "UNIQUE_CONTENT_XYZ" })
      mockHybrid = makeMockHybridSearchService([chunk])
      service = new RagService(mockHybrid, mockGen)

      await service.query("test")

      const [, chunks] = mockGen.generate.mock.calls[0] as [string, unknown[]]
      expect(JSON.stringify(chunks)).toContain("UNIQUE_CONTENT_XYZ")
    })

    it("returns chunksRetrieved from hybrid search result count", async () => {
      const threeChunks = [
        makeHybridSearchResult({ id: "a" }),
        makeHybridSearchResult({ id: "b" }),
        makeHybridSearchResult({ id: "c" }),
      ]
      mockHybrid = makeMockHybridSearchService(threeChunks)
      service = new RagService(mockHybrid, mockGen)

      const result = await service.query("test")
      expect(result.chunksRetrieved).toBe(3)
    })

    it("passes topK option to hybrid search", async () => {
      await service.query("test", { topK: 7 })

      expect(mockHybrid.search).toHaveBeenCalledWith("test", expect.objectContaining({ topK: 7 }))
    })

    it("durationMs is greater than zero", async () => {
      const result = await service.query("test")
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  // ── query() — zero results (fallback) ─────────────────────────────────
  describe("query() — fallback when no chunks retrieved", () => {
    beforeEach(() => {
      mockHybrid = makeMockHybridSearchService([]) // empty results
      service = new RagService(mockHybrid, mockGen)
    })

    it("calls generateWithFallback when no chunks found", async () => {
      await service.query("obscure query")
      expect(mockGen.generateWithFallback).toHaveBeenCalledTimes(1)
    })

    it("does NOT call generate() when no chunks found", async () => {
      await service.query("obscure query")
      expect(mockGen.generate).not.toHaveBeenCalled()
    })

    it("returns zero for chunksRetrieved when search finds nothing", async () => {
      const result = await service.query("obscure query")
      expect(result.chunksRetrieved).toBe(0)
    })

    it("returns zero tokensUsed for fallback response", async () => {
      const result = await service.query("obscure query")
      expect(result.tokensUsed).toBe(0)
    })

    it("returns empty citations for fallback response", async () => {
      const result = await service.query("obscure query")
      expect(result.citations).toHaveLength(0)
    })
  })

  // ── query() — retrieval error ──────────────────────────────────────────
  describe("query() — retrieval error", () => {
    it("propagates error when hybridSearch throws", async () => {
      mockHybrid.search.mockRejectedValueOnce(new Error("pgvector connection failed"))

      await expect(service.query("test")).rejects.toThrow("pgvector connection failed")
    })

    it("does not call generation if retrieval throws", async () => {
      mockHybrid.search.mockRejectedValueOnce(new Error("DB error"))

      await expect(service.query("test")).rejects.toThrow()
      expect(mockGen.generate).not.toHaveBeenCalled()
    })
  })

  // ── query() — generation error ─────────────────────────────────────────
  describe("query() — generation error", () => {
    it("propagates error when generation throws", async () => {
      mockGen.generate.mockRejectedValueOnce(new Error("Gemini API unavailable"))

      await expect(service.query("test")).rejects.toThrow("Gemini API unavailable")
    })
  })

  // ── query() — options ──────────────────────────────────────────────────
  describe("query() — options", () => {
    it("passes minSimilarity option to hybrid search", async () => {
      await service.query("test", { minSimilarity: 0.7 })

      expect(mockHybrid.search).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({ minSimilarity: 0.7 })
      )
    })

    it("passes documentIds option to hybrid search", async () => {
      const docIds = ["doc-1", "doc-2"]
      await service.query("test", { documentIds: docIds })

      expect(mockHybrid.search).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({ documentIds: docIds })
      )
    })

    it("uses default topK of 10 when not specified", async () => {
      await service.query("test")

      expect(mockHybrid.search).toHaveBeenCalledWith("test", expect.objectContaining({ topK: 10 }))
    })
  })
})
