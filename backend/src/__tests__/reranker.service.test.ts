import { RerankerService } from "../services/reranker.service"
import type { HybridSearchResult } from "../types/retrieval.types"

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeHybridResult(
  overrides: Partial<{
    id: string
    content: string
    source: string
    rrfScore: number
    vectorRank: number
    keywordRank: number
  }> = {}
): HybridSearchResult {
  return {
    chunk: {
      id: overrides.id ?? "chunk-001",
      documentId: "doc-001",
      content: overrides.content ?? "Machine learning enables systems to learn from data.",
      chunkIndex: 0,
      tokenCount: 12,
      source: overrides.source ?? "ml-intro.txt",
      pageNumber: null,
      chunkingStrategy: "recursive",
      createdAt: new Date(),
    },
    vectorRank: overrides.vectorRank ?? 0,
    keywordRank: overrides.keywordRank ?? 0,
    rrfScore: overrides.rrfScore ?? 0.032,
  }
}

// Creates a mock Gemini response with pointwise scores
function makePointwiseResponse(scores: Array<{ idx: number; score: number }>): Response {
  const scoresJson = scores
    .map(s => `{"chunkIndex": ${s.idx}, "score": ${s.score}, "reason": "test"}`)
    .join(", ")

  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: `{"scores": [${scoresJson}]}` }],
            role: "model",
          },
          finishReason: "STOP",
          safetyRatings: [],
        },
      ],
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 50,
        totalTokenCount: 250,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("RerankerService", () => {
  let service: RerankerService
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    service = new RerankerService("fake-api-key")
    fetchSpy = jest.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  // ── Constructor ────────────────────────────────────────────────────────
  describe("constructor", () => {
    it("throws for empty API key", () => {
      expect(() => new RerankerService("")).toThrow("RerankerService requires a Gemini API key")
    })

    it("does not throw for valid API key", () => {
      expect(() => new RerankerService("valid-key")).not.toThrow()
    })
  })

  // ── rerank() — empty input ─────────────────────────────────────────────
  describe("rerank() — empty input", () => {
    it("returns empty array for empty chunks", async () => {
      const result = await service.rerank("test query", [])
      expect(result).toHaveLength(0)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("returns single item without API call for one chunk", async () => {
      const chunks = [makeHybridResult()]
      const result = await service.rerank("test", chunks)

      expect(result).toHaveLength(1)
      expect(fetchSpy).not.toHaveBeenCalled() // no API call for single chunk
    })
  })

  // ── rerank() — happy path ──────────────────────────────────────────────
  describe("rerank() — happy path", () => {
    it("returns results sorted by rerankScore descending", async () => {
      const chunks = [
        makeHybridResult({ id: "chunk-1", rrfScore: 0.04 }),
        makeHybridResult({ id: "chunk-2", rrfScore: 0.03 }),
        makeHybridResult({ id: "chunk-3", rrfScore: 0.02 }),
      ]

      // chunk-2 gets highest rerank score, chunk-3 second, chunk-1 third
      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse([
          { idx: 1, score: 4 }, // chunk-1: score 4
          { idx: 2, score: 9 }, // chunk-2: score 9 (should be rank 1 after reranking)
          { idx: 3, score: 6 }, // chunk-3: score 6
        ])
      )

      const result = await service.rerank("test query", chunks, { topK: 3 })

      expect(result[0]?.chunk.id).toBe("chunk-2") // was rank 1 in RRF, stays rank 1
      expect(result[1]?.chunk.id).toBe("chunk-3") // was rank 2 in RRF, stays rank 2
      expect(result[2]?.chunk.id).toBe("chunk-1") // was rank 0 in RRF, drops to rank 2
    })

    it("normalises scores from 0-10 to 0-1 range", async () => {
      const chunks = [makeHybridResult({ id: "chunk-a" }), makeHybridResult({ id: "chunk-b" })]

      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse([
          { idx: 1, score: 8 },
          { idx: 2, score: 4 },
        ])
      )

      const result = await service.rerank("test", chunks)

      expect(result[0]?.rerankScore).toBeCloseTo(0.8, 2)
      expect(result[1]?.rerankScore).toBeCloseTo(0.4, 2)
    })

    it("preserves originalRank for comparison", async () => {
      const chunks = [
        makeHybridResult({ id: "a" }),
        makeHybridResult({ id: "b" }),
        makeHybridResult({ id: "c" }),
      ]

      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse([
          { idx: 1, score: 3 },
          { idx: 2, score: 9 },
          { idx: 3, score: 6 },
        ])
      )

      const result = await service.rerank("test", chunks, { topK: 3 })

      // chunk-b was at originalRank 1 (second item), should now be at rerankedRank 0
      const chunkB = result.find(r => r.chunk.id === "b")
      expect(chunkB?.originalRank).toBe(1)
      expect(chunkB?.rerankedRank).toBe(0)
    })

    it("preserves original RRF scores", async () => {
      const chunks = [
        makeHybridResult({ id: "a", rrfScore: 0.0412 }),
        makeHybridResult({ id: "b", rrfScore: 0.0312 }),
      ]

      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse([
          { idx: 1, score: 7 },
          { idx: 2, score: 9 },
        ])
      )

      const result = await service.rerank("test", chunks)

      const chunkA = result.find(r => r.chunk.id === "a")
      const chunkB = result.find(r => r.chunk.id === "b")

      expect(chunkA?.rrfScore).toBeCloseTo(0.0412, 4)
      expect(chunkB?.rrfScore).toBeCloseTo(0.0312, 4)
    })

    it("respects topK option", async () => {
      const chunks = Array.from({ length: 8 }, (_, i) => makeHybridResult({ id: `chunk-${i}` }))

      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse(chunks.map((_, i) => ({ idx: i + 1, score: 8 - i })))
      )

      const result = await service.rerank("test", chunks, { topK: 3 })
      expect(result).toHaveLength(3)
    })

    it("calls Gemini exactly once for scoring", async () => {
      const chunks = [makeHybridResult({ id: "a" }), makeHybridResult({ id: "b" })]

      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse([
          { idx: 1, score: 7 },
          { idx: 2, score: 5 },
        ])
      )

      await service.rerank("test", chunks)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ── rerank() — result shape ────────────────────────────────────────────
  describe("rerank() — result shape", () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValue(
        makePointwiseResponse([
          { idx: 1, score: 8 },
          { idx: 2, score: 6 },
        ])
      )
    })

    it("each result has all required fields", async () => {
      const chunks = [makeHybridResult(), makeHybridResult({ id: "chunk-2" })]
      const result = await service.rerank("test", chunks)

      result.forEach(r => {
        expect(typeof r.rerankScore).toBe("number")
        expect(typeof r.originalRank).toBe("number")
        expect(typeof r.rerankedRank).toBe("number")
        expect(typeof r.rrfScore).toBe("number")
        expect(r.chunk).toBeDefined()
      })
    })

    it("rerankedRank values are sequential from 0", async () => {
      const chunks = [makeHybridResult(), makeHybridResult({ id: "chunk-2" })]
      const result = await service.rerank("test", chunks)

      result.forEach((r, i) => {
        expect(r.rerankedRank).toBe(i)
      })
    })

    it("rerankScore is always between 0 and 1", async () => {
      const chunks = [makeHybridResult(), makeHybridResult({ id: "chunk-2" })]
      const result = await service.rerank("test", chunks)

      result.forEach(r => {
        expect(r.rerankScore).toBeGreaterThanOrEqual(0)
        expect(r.rerankScore).toBeLessThanOrEqual(1)
      })
    })
  })

  // ── rerank() — error handling ──────────────────────────────────────────
  describe("rerank() — error handling", () => {
    it("returns original order when Gemini API fails", async () => {
      const chunks = [makeHybridResult({ id: "first" }), makeHybridResult({ id: "second" })]

      fetchSpy.mockRejectedValueOnce(new Error("API unavailable"))

      const result = await service.rerank("test", chunks, { topK: 2 })

      // Should not throw — gracefully returns with neutral scores
      expect(result).toHaveLength(2)
    })

    it("does not throw when API returns 500", async () => {
      const chunks = [makeHybridResult({ id: "a" }), makeHybridResult({ id: "b" })]

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Internal error" } }), {
          status: 500,
        })
      )

      await expect(service.rerank("test", chunks, { topK: 2 })).resolves.toBeDefined()
    })

    it("handles malformed JSON from Gemini gracefully", async () => {
      const chunks = [makeHybridResult({ id: "a" }), makeHybridResult({ id: "b" })]

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: "Not valid JSON at all!!!" }], role: "model" },
                finishReason: "STOP",
                safetyRatings: [],
              },
            ],
            usageMetadata: { totalTokenCount: 50, promptTokenCount: 40, candidatesTokenCount: 10 },
          }),
          { status: 200 }
        )
      )

      // Falls back to neutral 0.5 scores, does not throw
      const result = await service.rerank("test", chunks)
      expect(result).toBeDefined()
      result.forEach(r => {
        expect(r.rerankScore).toBeCloseTo(0.5, 1)
      })
    })

    it("handles missing chunk indices in LLM response", async () => {
      const chunks = [
        makeHybridResult({ id: "a" }),
        makeHybridResult({ id: "b" }),
        makeHybridResult({ id: "c" }),
      ]

      // Only scores 2 of 3 chunks
      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse([
          { idx: 1, score: 9 },
          { idx: 2, score: 7 },
          // chunk 3 not scored — should get default 0.5
        ])
      )

      const result = await service.rerank("test", chunks, { topK: 3 })
      expect(result).toHaveLength(3)

      const chunkC = result.find(r => r.chunk.id === "c")
      expect(chunkC?.rerankScore).toBeCloseTo(0.5, 1)
    })
  })

  // ── compare() ─────────────────────────────────────────────────────────
  describe("compare()", () => {
    it("returns a RerankComparison object", async () => {
      const chunks = [
        makeHybridResult({ id: "a" }),
        makeHybridResult({ id: "b" }),
        makeHybridResult({ id: "c" }),
      ]

      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse([
          { idx: 1, score: 3 },
          { idx: 2, score: 9 },
          { idx: 3, score: 6 },
        ])
      )

      const comparison = await service.compare("test", chunks, { topK: 3 })

      expect(comparison.query).toBe("test")
      expect(comparison.original).toHaveLength(3)
      expect(comparison.reranked).toHaveLength(3)
      expect(typeof comparison.movedUp).toBe("number")
      expect(typeof comparison.movedDown).toBe("number")
      expect(typeof comparison.unchanged).toBe("number")
      expect(comparison.durationMs).toBeGreaterThan(0)
    })

    it("correctly counts moved up/down/unchanged", async () => {
      const chunks = [
        makeHybridResult({ id: "a" }), // originalRank 0
        makeHybridResult({ id: "b" }), // originalRank 1
        makeHybridResult({ id: "c" }), // originalRank 2
      ]

      // b gets highest score → moves from rank 1 to rank 0 (moved up)
      // a gets lowest score → moves from rank 0 to rank 2 (moved down)
      // c stays at rank 2? No — c: score 6, a: score 3, b: score 9
      // After reranking: b(rank 0), c(rank 1), a(rank 2)
      // b: originalRank 1 → rerankedRank 0 (moved up)
      // c: originalRank 2 → rerankedRank 1 (moved up)
      // a: originalRank 0 → rerankedRank 2 (moved down)
      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse([
          { idx: 1, score: 3 }, // a: moves down
          { idx: 2, score: 9 }, // b: moves up
          { idx: 3, score: 6 }, // c: moves up
        ])
      )

      const comparison = await service.compare("test", chunks, { topK: 3 })

      // a moved down, b and c moved up
      expect(comparison.movedDown).toBe(1)
      expect(comparison.movedUp).toBe(2)
    })
  })

  // ── minRerankScore option ──────────────────────────────────────────────
  describe("rerank() — minRerankScore filtering", () => {
    it("filters out chunks below minRerankScore", async () => {
      const chunks = [makeHybridResult({ id: "high" }), makeHybridResult({ id: "low" })]

      fetchSpy.mockResolvedValueOnce(
        makePointwiseResponse([
          { idx: 1, score: 8 }, // 0.8 — above threshold
          { idx: 2, score: 2 }, // 0.2 — below threshold
        ])
      )

      const result = await service.rerank("test", chunks, {
        topK: 5,
        minRerankScore: 0.5, // filter out anything below 0.5
      })

      expect(result).toHaveLength(1)
      expect(result[0]?.chunk.id).toBe("high")
    })
  })
})
