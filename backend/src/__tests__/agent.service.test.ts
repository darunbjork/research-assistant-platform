// backend/src/__tests__/agent.service.test.ts
// Tests for AgentService and the ReAct loop.
//
// TESTING STRATEGY:
// AgentService calls Gemini for reasoning AND generation.
// We mock global fetch to intercept both calls.
// We mock HybridSearchService and GenerationService via jest.fn().
//
// KEY THINGS TO TEST:
// 1. The loop terminates (never infinite)
// 2. DONE decision exits immediately
// 3. Tool calls are recorded in history
// 4. Unknown tool names are handled gracefully
// 5. Fallback when no tools are called

import { AgentService } from "../services/agent.service"
import type { HybridSearchService } from "../services/hybrid.search.service"
import type { GenerationService } from "../services/generation.service"

// ── Mock Factories ────────────────────────────────────────────────────────

function makeMockHybridSearch(): jest.Mocked<HybridSearchService> {
  return {
    search: jest.fn().mockResolvedValue([]),
    compareStrategies: jest.fn().mockResolvedValue({}),
    toCitations: jest.fn().mockReturnValue([]),
  } as unknown as jest.Mocked<HybridSearchService>
}

function makeMockGenerationService(): jest.Mocked<GenerationService> {
  return {
    generate: jest.fn().mockResolvedValue({
      answer: "Mock answer from GenerationService",
      citations: [],
      tokensUsed: 100,
      model: "gemini-2.0-flash",
      durationMs: 500,
    }),
    generateWithFallback: jest.fn().mockResolvedValue({
      answer: "I don't have enough information.",
      citations: [],
      tokensUsed: 0,
      model: "gemini-2.0-flash",
      durationMs: 5,
    }),
    estimatePromptTokens: jest.fn().mockReturnValue(500),
  } as unknown as jest.Mocked<GenerationService>
}

// Creates a mock Gemini response for the ReAct reasoning step
function makeDoneDecisionResponse(): Response {
  const body = {
    candidates: [
      {
        content: {
          parts: [{ text: '{"toolName":"DONE","input":{},"reason":"I have enough information."}' }],
          role: "model",
        },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
    },
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function makeRagSearchDecisionResponse(): Response {
  const body = {
    candidates: [
      {
        content: {
          parts: [
            {
              text: '{"toolName":"rag_search","input":{"query":"machine learning"},"reason":"Need to find info about ML."}',
            },
          ],
          role: "model",
        },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: {
      promptTokenCount: 150,
      candidatesTokenCount: 30,
      totalTokenCount: 180,
    },
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function makeCalculatorDecisionResponse(): Response {
  const body = {
    candidates: [
      {
        content: {
          parts: [
            {
              text: '{"toolName":"calculator","input":{"expression":"4.2+5.1"},"reason":"Need to add the values."}',
            },
          ],
          role: "model",
        },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
    },
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function makeSynthesisResponse(text: string = "The answer is 42."): Response {
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
      promptTokenCount: 300,
      candidatesTokenCount: 50,
      totalTokenCount: 350,
    },
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("AgentService", () => {
  let service: AgentService
  let mockHybridSearch: jest.Mocked<HybridSearchService>
  let mockGeneration: jest.Mocked<GenerationService>
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    mockHybridSearch = makeMockHybridSearch()
    mockGeneration = makeMockGenerationService()
    service = new AgentService("fake-api-key", mockHybridSearch, mockGeneration)
    fetchSpy = jest.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  // ── Constructor ────────────────────────────────────────────────────────
  describe("constructor", () => {
    it("throws if API key is empty", () => {
      expect(() => new AgentService("", mockHybridSearch, mockGeneration)).toThrow(
        "AgentService requires a Gemini API key"
      )
    })

    it("does not throw with a valid key", () => {
      expect(() => new AgentService("valid-key", mockHybridSearch, mockGeneration)).not.toThrow()
    })
  })

  // ── run() — DONE immediately ───────────────────────────────────────────
  describe("run() — DONE decision on first iteration", () => {
    beforeEach(() => {
      // First call: reasoning → DONE
      // Second call: synthesis → final answer
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse("The answer based on no tools."))
    })

    it("returns an AgentResult object", async () => {
      const result = await service.run("What is ML?", "user-123")
      expect(result).toBeDefined()
      expect(typeof result.finalAnswer).toBe("string")
    })

    it("has a valid sessionId", async () => {
      const result = await service.run("What is ML?", "user-123")
      expect(result.sessionId).toBeTruthy()
      expect(typeof result.sessionId).toBe("string")
    })

    it("status is 'done'", async () => {
      const result = await service.run("What is ML?", "user-123")
      expect(result.status).toBe("done")
    })

    it("iterationCount is 1 when DONE on first iteration", async () => {
      const result = await service.run("What is ML?", "user-123")
      expect(result.iterationCount).toBe(1)
    })

    it("steps array has one entry", async () => {
      const result = await service.run("What is ML?", "user-123")
      expect(result.steps).toHaveLength(1)
    })

    it("durationMs is positive", async () => {
      const result = await service.run("What is ML?", "user-123")
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  // ── run() — one tool call then DONE ────────────────────────────────────
  describe("run() — one rag_search then DONE", () => {
    beforeEach(() => {
      // Call 1: reasoning → rag_search
      // Call 2: reasoning → DONE (after seeing search results)
      // Call 3: synthesis
      fetchSpy
        .mockResolvedValueOnce(makeRagSearchDecisionResponse())
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse("ML is a subset of AI."))
    })

    it("calls HybridSearchService once", async () => {
      await service.run("What is machine learning?", "user-123")
      expect(mockHybridSearch.search).toHaveBeenCalledTimes(1)
    })

    it("calls HybridSearchService with the correct query", async () => {
      await service.run("What is machine learning?", "user-123")
      expect(mockHybridSearch.search).toHaveBeenCalledWith(
        "machine learning",
        expect.objectContaining({ userId: "user-123" })
      )
    })

    it("iterationCount is 2 (one search + one DONE)", async () => {
      const result = await service.run("What is machine learning?", "user-123")
      expect(result.iterationCount).toBe(2)
    })

    it("steps includes the rag_search step", async () => {
      const result = await service.run("What is machine learning?", "user-123")
      const searchStep = result.steps.find(s => s.toolUsed === "rag_search")
      expect(searchStep).toBeDefined()
    })

    it("steps description mentions the search query", async () => {
      const result = await service.run("What is machine learning?", "user-123")
      const searchStep = result.steps.find(s => s.toolUsed === "rag_search")
      expect(searchStep?.description).toContain("machine learning")
    })

    it("returns the synthesised answer from Gemini", async () => {
      const result = await service.run("What is machine learning?", "user-123")
      expect(result.finalAnswer).toBe("ML is a subset of AI.")
    })
  })

  // ── run() — calculator tool ────────────────────────────────────────────
  describe("run() — calculator tool", () => {
    beforeEach(() => {
      fetchSpy
        .mockResolvedValueOnce(makeCalculatorDecisionResponse())
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse("The sum is 9.3"))
    })

    it("calculator tool executes without calling HybridSearchService", async () => {
      await service.run("What is 4.2 + 5.1?", "user-123")
      expect(mockHybridSearch.search).not.toHaveBeenCalled()
    })

    it("steps includes the calculator step", async () => {
      const result = await service.run("What is 4.2 + 5.1?", "user-123")
      const calcStep = result.steps.find(s => s.toolUsed === "calculator")
      expect(calcStep).toBeDefined()
    })
  })

  // ── run() — max iterations safety ──────────────────────────────────────
  describe("run() — max iterations safety", () => {
    it("never exceeds MAX_ITERATIONS (5) even if LLM never says DONE", async () => {
      // Create 5 separate rag_search decision responses (one per iteration)
      const ragSearchResponses = Array.from({ length: 5 }, () => makeRagSearchDecisionResponse())
      // Final synthesis response
      const synthesisResponse = makeSynthesisResponse("Best effort answer.")

      fetchSpy
        .mockResolvedValueOnce(ragSearchResponses[0])
        .mockResolvedValueOnce(ragSearchResponses[1])
        .mockResolvedValueOnce(ragSearchResponses[2])
        .mockResolvedValueOnce(ragSearchResponses[3])
        .mockResolvedValueOnce(ragSearchResponses[4])
        .mockResolvedValueOnce(synthesisResponse)

      const result = await service.run("Keep searching forever", "user-123")

      // iterationCount must be <= 5 (the agent may stop earlier if it decides DONE,
      // but with forced rag_search it will hit max iterations)
      expect(result.iterationCount).toBeLessThanOrEqual(5)
    })

    it("still returns a result when max iterations reached", async () => {
      // Create 5 rag_search responses (each iteration) + 1 synthesis

      const synthesisResponse = makeSynthesisResponse("Best effort answer.")

      // Set up spy to return rag_search for the first 5 calls, then synthesis
      let callCount = 0
      fetchSpy.mockImplementation(() => {
        if (callCount < 5) {
          callCount++
          return Promise.resolve(makeRagSearchDecisionResponse())
        }
        return Promise.resolve(synthesisResponse)
      })

      const result = await service.run("Keep searching", "user-123")
      expect(result.finalAnswer).toBeDefined()
      expect(result.status).toBeDefined()
    })
  })

  // ── run() — unknown tool name ───────────────────────────────────────────
  describe("run() — unknown tool graceful handling", () => {
    it("handles unknown tool name without crashing", async () => {
      const unknownToolResponse = new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"toolName":"nonexistent_tool","input":{},"reason":"test"}' }],
                role: "model",
              },
              finishReason: "STOP",
              safetyRatings: [],
            },
          ],
          usageMetadata: { totalTokenCount: 50, promptTokenCount: 40, candidatesTokenCount: 10 },
        }),
        { status: 200 }
      )

      fetchSpy
        .mockResolvedValueOnce(unknownToolResponse) // unknown tool
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse("Handled gracefully."))

      await expect(service.run("test query", "user-123")).resolves.toBeDefined()
    })
  })

  // ── run() — malformed JSON from LLM ────────────────────────────────────
  describe("run() — malformed LLM response", () => {
    it("falls back to DONE when LLM returns non-JSON", async () => {
      const malformedResponse = new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "I think I should search for information about this topic." }],
                role: "model",
              },
              finishReason: "STOP",
              safetyRatings: [],
            },
          ],
          usageMetadata: { totalTokenCount: 50, promptTokenCount: 40, candidatesTokenCount: 10 },
        }),
        { status: 200 }
      )

      fetchSpy
        .mockResolvedValueOnce(malformedResponse) // non-JSON → parsed as DONE
        .mockResolvedValueOnce(makeSynthesisResponse("Fallback answer."))

      const result = await service.run("test query", "user-123")

      // Should not throw — parse error defaults to DONE
      expect(result).toBeDefined()
      expect(result.status).toBe("done")
    })
  })

  // ── run() — result shape ───────────────────────────────────────────────
  describe("run() — result shape", () => {
    beforeEach(() => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())
    })

    it("result has all required fields", async () => {
      const result = await service.run("test", "user-123")

      expect(typeof result.sessionId).toBe("string")
      expect(typeof result.finalAnswer).toBe("string")
      expect(Array.isArray(result.citations)).toBe(true)
      expect(Array.isArray(result.steps)).toBe(true)
      expect(typeof result.iterationCount).toBe("number")
      expect(typeof result.tokensUsed).toBe("number")
      expect(typeof result.durationMs).toBe("number")
    })

    it("tokensUsed is non-negative", async () => {
      const result = await service.run("test", "user-123")
      expect(result.tokensUsed).toBeGreaterThanOrEqual(0)
    })

    it("each step has required fields", async () => {
      const result = await service.run("test", "user-123")

      result.steps.forEach(step => {
        expect(typeof step.stepNumber).toBe("number")
        expect(typeof step.description).toBe("string")
        expect(typeof step.durationMs).toBe("number")
        expect(step.timestamp).toBeInstanceOf(Date)
      })
    })
  })
})
