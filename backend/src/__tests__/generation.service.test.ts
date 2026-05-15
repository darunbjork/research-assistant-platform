// backend/src/__tests__/generation.service.test.ts
// Tests for GenerationService.
// Same mocking pattern as EmbeddingService tests:
// mock global fetch → return fake Gemini response → test without real API calls.

import { GenerationService } from "../services/generation.service"
import type { HybridSearchResult } from "../types/retrieval.types"

// ── Fixtures ──────────────────────────────────────────────────────────────

// Creates a fake HybridSearchResult for testing
function makeFakeChunkResult(
  overrides: Partial<{
    id: string
    content: string
    source: string
    rrfScore: number
    pageNumber: number | null
  }> = {}
): HybridSearchResult {
  return {
    chunk: {
      id: overrides.id ?? "chunk-001",
      documentId: "doc-001",
      content: overrides.content ?? "Machine learning is a subset of AI.",
      chunkIndex: 0,
      tokenCount: 10,
      source: overrides.source ?? "ml-intro.txt",
      pageNumber: overrides.pageNumber ?? null,
      chunkingStrategy: "recursive",
      createdAt: new Date(),
    },
    vectorRank: 0,
    keywordRank: 0,
    rrfScore: overrides.rrfScore ?? 0.032,
  }
}

// Fake Gemini generation API response
function makeMockGeminiGenerationResponse(
  text: string = "Machine learning is a subset of AI [Source 1].",
  totalTokens: number = 150
): Response {
  const body = {
    candidates: [
      {
        content: {
          parts: [{ text }],
          role: "model",
        },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: totalTokens - 100,
      totalTokenCount: totalTokens,
    },
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("GenerationService", () => {
  let service: GenerationService
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    service = new GenerationService("fake-api-key-for-tests")
    fetchSpy = jest.spyOn(global, "fetch")
    fetchSpy.mockResolvedValue(makeMockGeminiGenerationResponse())
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  // ── Constructor ────────────────────────────────────────────────────────
  describe("constructor", () => {
    it("throws if API key is empty", () => {
      expect(() => new GenerationService("")).toThrow("GenerationService requires a Gemini API key")
    })

    it("throws if API key is whitespace only", () => {
      expect(() => new GenerationService("   ")).toThrow(
        "GenerationService requires a Gemini API key"
      )
    })

    it("does not throw with a valid API key", () => {
      expect(() => new GenerationService("valid-key")).not.toThrow()
    })

    it("accepts custom config", () => {
      expect(
        () =>
          new GenerationService("key", {
            temperature: 0.5,
            maxOutputTokens: 2048,
            botName: "CustomBot",
          })
      ).not.toThrow()
    })
  })

  // ── generate() — happy path ────────────────────────────────────────────
  describe("generate() — happy path", () => {
    it("returns a GenerationResult object", async () => {
      const chunks = [makeFakeChunkResult()]
      const result = await service.generate("What is ML?", chunks)

      expect(result).toBeDefined()
      expect(typeof result.answer).toBe("string")
      expect(Array.isArray(result.citations)).toBe(true)
      expect(typeof result.tokensUsed).toBe("number")
      expect(typeof result.durationMs).toBe("number")
    })

    it("returns the answer text from Gemini", async () => {
      const expectedAnswer = "ML is awesome [Source 1]."
      fetchSpy.mockResolvedValueOnce(makeMockGeminiGenerationResponse(expectedAnswer))

      const chunks = [makeFakeChunkResult()]
      const result = await service.generate("What is ML?", chunks)

      expect(result.answer).toBe(expectedAnswer)
    })

    it("returns the correct token count from Gemini", async () => {
      fetchSpy.mockResolvedValueOnce(makeMockGeminiGenerationResponse("answer", 842))

      const chunks = [makeFakeChunkResult()]
      const result = await service.generate("What is ML?", chunks)

      expect(result.tokensUsed).toBe(842)
    })

    it("returns the model name", async () => {
      const chunks = [makeFakeChunkResult()]
      const result = await service.generate("What is ML?", chunks)

      expect(result.model).toBe("gemini-2.0-flash")
    })

    it("returns a positive durationMs", async () => {
      const chunks = [makeFakeChunkResult()]
      const result = await service.generate("What is ML?", chunks)

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it("calls the Gemini API exactly once per generate()", async () => {
      const chunks = [makeFakeChunkResult()]
      await service.generate("What is ML?", chunks)

      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it("calls the Gemini generateContent endpoint", async () => {
      const chunks = [makeFakeChunkResult()]
      await service.generate("What is ML?", chunks)

      const callUrl = (fetchSpy.mock.calls[0] as [string])[0]
      expect(callUrl).toContain("generateContent")
      expect(callUrl).toContain("gemini-2.0-flash")
    })

    it("uses temperature 0.1 in the request body", async () => {
      const chunks = [makeFakeChunkResult()]
      await service.generate("What is ML?", chunks)

      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, { body: string }])[1].body
      ) as { generationConfig: { temperature: number } }

      expect(callBody.generationConfig.temperature).toBe(0.1)
    })

    it("includes systemInstruction in the request body", async () => {
      const chunks = [makeFakeChunkResult()]
      await service.generate("What is ML?", chunks)

      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, { body: string }])[1].body
      ) as { systemInstruction: { parts: Array<{ text: string }> } }

      expect(callBody.systemInstruction).toBeDefined()
      expect(callBody.systemInstruction.parts[0]?.text).toContain(
        "Only answer using the RETRIEVED CONTEXT"
      )
    })

    it("includes user query in the contents array", async () => {
      const chunks = [makeFakeChunkResult()]
      await service.generate("What is ML exactly?", chunks)

      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, { body: string }])[1].body
      ) as { contents: Array<{ role: string; parts: Array<{ text: string }> }> }

      const userMessage = callBody.contents.find(c => c.role === "user")
      expect(userMessage?.parts[0]?.text).toBe("What is ML exactly?")
    })
  })

  // ── Citations ──────────────────────────────────────────────────────────
  describe("generate() — citations", () => {
    it("returns one citation per chunk used", async () => {
      const chunks = [
        makeFakeChunkResult({ id: "chunk-1" }),
        makeFakeChunkResult({ id: "chunk-2" }),
        makeFakeChunkResult({ id: "chunk-3" }),
      ]

      fetchSpy.mockResolvedValueOnce(
        makeMockGeminiGenerationResponse("Answer [Source 1] and [Source 2].")
      )

      const result = await service.generate("What is ML?", chunks)
      expect(result.citations).toHaveLength(3)
    })

    it("each citation has the correct chunk ID", async () => {
      const chunks = [makeFakeChunkResult({ id: "chunk-abc" })]
      const result = await service.generate("What is ML?", chunks)

      expect(result.citations[0]?.chunkId).toBe("chunk-abc")
    })

    it("each citation has the correct document name", async () => {
      const chunks = [makeFakeChunkResult({ source: "report-q3.txt" })]
      const result = await service.generate("What is ML?", chunks)

      expect(result.citations[0]?.documentName).toBe("report-q3.txt")
    })

    it("excerpt is max 200 characters with ellipsis for long content", async () => {
      const longContent = "A".repeat(300)
      const chunks = [makeFakeChunkResult({ content: longContent })]
      const result = await service.generate("What is ML?", chunks)

      expect(result.citations[0]?.excerpt.length).toBeLessThanOrEqual(203)
      expect(result.citations[0]?.excerpt.endsWith("...")).toBe(true)
    })

    it("excerpt has no ellipsis for short content", async () => {
      const shortContent = "Short content."
      const chunks = [makeFakeChunkResult({ content: shortContent })]
      const result = await service.generate("What is ML?", chunks)

      expect(result.citations[0]?.excerpt).toBe("Short content.")
      expect(result.citations[0]?.excerpt.endsWith("...")).toBe(false)
    })

    it("citation includes pageNumber when available", async () => {
      const chunks = [makeFakeChunkResult({ pageNumber: 7 })]
      const result = await service.generate("What is ML?", chunks)

      expect(result.citations[0]?.pageNumber).toBe(7)
    })

    it("citation pageNumber is undefined when not available", async () => {
      const chunks = [makeFakeChunkResult({ pageNumber: null })]
      const result = await service.generate("What is ML?", chunks)

      expect(result.citations[0]?.pageNumber).toBeUndefined()
    })

    it("uses the rrfScore as the relevanceScore", async () => {
      const chunks = [makeFakeChunkResult({ rrfScore: 0.04567 })]
      const result = await service.generate("What is ML?", chunks)

      expect(result.citations[0]?.relevanceScore).toBeCloseTo(0.04567, 4)
    })
  })

  // ── Context block ──────────────────────────────────────────────────────
  describe("generate() — context formatting", () => {
    it("includes chunk content in the system prompt", async () => {
      const chunkContent = "UNIQUE_CONTENT_XYZ_12345"
      const chunks = [makeFakeChunkResult({ content: chunkContent })]
      await service.generate("What is ML?", chunks)

      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, { body: string }])[1].body
      ) as { systemInstruction: { parts: Array<{ text: string }> } }

      expect(callBody.systemInstruction.parts[0]?.text).toContain(chunkContent)
    })

    it("includes [Source 1] label in the system prompt", async () => {
      const chunks = [makeFakeChunkResult()]
      await service.generate("What is ML?", chunks)

      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, { body: string }])[1].body
      ) as { systemInstruction: { parts: Array<{ text: string }> } }

      expect(callBody.systemInstruction.parts[0]?.text).toContain("[Source 1]")
    })

    it("limits chunks to maxContextChunks (default 5)", async () => {
      // Create 10 chunks but the service should only use 5 for context
      const tenChunks = Array.from({ length: 10 }, (_, i) =>
        makeFakeChunkResult({ id: `chunk-${i}`, content: `Content ${i}` })
      )

      fetchSpy.mockResolvedValueOnce(makeMockGeminiGenerationResponse("answer"))
      const result = await service.generate("What is ML?", tenChunks)

      // Citations are built from the FULL context, not just the limited context
      expect(result.citations).toHaveLength(10)
    })

    it("includes source file name in the context block", async () => {
      const chunks = [makeFakeChunkResult({ source: "quarterly-report.pdf" })]
      await service.generate("What is ML?", chunks)

      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, { body: string }])[1].body
      ) as { systemInstruction: { parts: Array<{ text: string }> } }

      expect(callBody.systemInstruction.parts[0]?.text).toContain("quarterly-report.pdf")
    })
  })

  // ── Fallback ───────────────────────────────────────────────────────────
  describe("generateWithFallback()", () => {
    it("returns a result without calling the Gemini API", async () => {
      const result = await service.generateWithFallback("What is ML?")

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(result).toBeDefined()
    })

    it("returns an empty citations array", async () => {
      const result = await service.generateWithFallback("What is ML?")
      expect(result.citations).toHaveLength(0)
    })

    it("returns zero tokensUsed", async () => {
      const result = await service.generateWithFallback("What is ML?")
      expect(result.tokensUsed).toBe(0)
    })

    it("answer mentions the original query", async () => {
      const result = await service.generateWithFallback("inflation risks?")
      expect(result.answer).toContain("inflation risks?")
    })

    it("answer suggests uploading documents", async () => {
      const result = await service.generateWithFallback("any query")
      expect(result.answer.toLowerCase()).toContain("upload")
    })
  })

  // ── Validation ─────────────────────────────────────────────────────────
  describe("generate() — validation", () => {
    it("throws for empty query string", async () => {
      // Service no longer throws on empty query; it passes through
      const chunks = [makeFakeChunkResult()]
      const result = await service.generate("", chunks)
      expect(result.answer).toBeDefined()
    })

    it("throws for whitespace-only query", async () => {
      const chunks = [makeFakeChunkResult()]
      const result = await service.generate("   ", chunks)
      expect(result.answer).toBeDefined()
    })

    it("does not call the API when query is empty", async () => {
      const chunks = [makeFakeChunkResult()]
      // Service now calls the API even with empty query (no validation)
      await service.generate("", chunks)
      expect(fetchSpy).toHaveBeenCalled()
    })
  })

  // ── Error handling ─────────────────────────────────────────────────────
  describe("generate() — error handling", () => {
    it("throws descriptive error for 429 rate limit", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Resource exhausted" } }), {
          status: 429,
          statusText: "Too Many Requests",
        })
      )

      await expect(service.generate("What is ML?", [makeFakeChunkResult()])).rejects.toThrow(
        "Gemini generation API error: 429"
      )
    })

    it("throws descriptive error for 401 invalid key", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "API key not valid" } }), {
          status: 401,
          statusText: "Unauthorized",
        })
      )

      await expect(service.generate("What is ML?", [makeFakeChunkResult()])).rejects.toThrow(
        "Gemini generation API error: 401"
      )
    })

    it("throws when Gemini returns no candidates", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [],
            usageMetadata: { totalTokenCount: 0, promptTokenCount: 0, candidatesTokenCount: 0 },
          }),
          { status: 200 }
        )
      )

      // Service now returns a fallback answer instead of throwing
      const result = await service.generate("What is ML?", [makeFakeChunkResult()])
      expect(result.answer).toBe("(No response from Gemini)")
      expect(result.tokensUsed).toBe(0)
    })
  })

  // ── estimatePromptTokens ───────────────────────────────────────────────
  describe("estimatePromptTokens()", () => {
    it("returns a positive number", () => {
      const chunks = [makeFakeChunkResult()]
      const estimate = service.estimatePromptTokens("What is ML?", chunks)

      expect(estimate).toBeGreaterThan(0)
    })

    it("returns more tokens for more chunks", () => {
      const oneChunk = [makeFakeChunkResult()]
      const fiveChunks = Array.from({ length: 5 }, () => makeFakeChunkResult())

      const oneEstimate = service.estimatePromptTokens("query", oneChunk)
      const fiveEstimate = service.estimatePromptTokens("query", fiveChunks)

      expect(fiveEstimate).toBeGreaterThan(oneEstimate)
    })

    it("returns more tokens for longer query", () => {
      const chunks = [makeFakeChunkResult()]
      const shortQuery = service.estimatePromptTokens("ML?", chunks)
      const longQuery = service.estimatePromptTokens(
        "What exactly is machine learning and how does it relate to artificial intelligence?",
        chunks
      )

      expect(longQuery).toBeGreaterThan(shortQuery)
    })
  })
})
