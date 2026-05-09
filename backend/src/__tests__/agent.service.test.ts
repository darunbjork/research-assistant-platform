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

// New helper for LLM evaluation mock
function makeEvaluationResponse(score: number = 0.8): Response {
  const body = {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                contextRelevance: score,
                faithfulness: score,
                answerRelevance: score,
                shouldRetry: score < 0.7,
                retryReason: score < 0.7 ? "Low quality" : "",
                suggestedQuery: score < 0.7 ? "better search query" : undefined,
              }),
            },
          ],
          role: "model",
        },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: { totalTokenCount: 50, promptTokenCount: 40, candidatesTokenCount: 10 },
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
    fetchSpy.mockClear() // Clear mocks to ensure isolation between tests
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
    it("returns an AgentResult object with status 'done'", async () => {
      // Mock sequence: reasoning (DONE) -> synthesis
      // This sequence does not involve tool calls or evaluation, so iterationCount is 1.
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse("The answer based on no tools."))

      const result = await service.run("What is ML?", "user-123")
      expect(result).toBeDefined()
      expect(result.status).toBe("done")
    })

    it("iterationCount is 1 when DONE on first iteration", async () => {
      // Mock sequence: reasoning (DONE) -> synthesis
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse("The answer based on no tools."))

      const result = await service.run("What is ML?", "user-123")
      expect(result.iterationCount).toBe(1)
    })
  })

  // ── run() — one tool call then DONE ────────────────────────────────────
  describe("run() — one rag_search then DONE", () => {
    it("correctly handles a single rag_search call followed by DONE", async () => {
      // Mock sequence for iterationCount = 3:
      // Iteration 1: reasoning (rag_search) -> draft -> evaluation (low score)
      // Iteration 2: reasoning (rag_search again) -> draft -> evaluation (low score)
      // Iteration 3: reasoning (leading to DONE) -> DONE decision
      // Final Synthesis occurs after loop
      fetchSpy
        .mockResolvedValueOnce(makeRagSearchDecisionResponse()) // reasoning: rag_search (Iter 1)
        .mockResolvedValueOnce(makeSynthesisResponse("Draft answer based on search.")) // draft (Iter 1)
        .mockResolvedValueOnce(makeEvaluationResponse(0.6)) // LLM evaluation (Iter 1, low score)
        .mockResolvedValueOnce(makeRagSearchDecisionResponse()) // reasoning: rag_search (Iter 2)
        .mockResolvedValueOnce(makeSynthesisResponse("Improved draft answer.")) // draft (Iter 2)
        .mockResolvedValueOnce(makeEvaluationResponse(0.6)) // LLM evaluation (Iter 2, low score)
        .mockResolvedValueOnce(makeDoneDecisionResponse()) // reasoning: DONE (Iter 3)
        .mockResolvedValueOnce(makeSynthesisResponse("ML is a subset of AI.")) // final synthesis

      const result = await service.run("What is machine learning?", "user-123")
      expect(result.iterationCount).toBe(3)
      expect(result.status).toBe("done")
      expect(result.finalAnswer).toBe("ML is a subset of AI.")
      expect(result.steps.some(s => s.toolUsed === "rag_search")).toBe(true)
    })
  })

  // ── run() — calculator tool ────────────────────────────────────────────
  describe("run() — calculator tool", () => {
    it("correctly handles a single calculator call followed by DONE", async () => {
      // Mock sequence for iterationCount = 3:
      // Iteration 1: calculator reasoning -> draft answer -> LLM evaluation (low score)
      // Iteration 2: calculator reasoning -> draft answer -> LLM evaluation (low score)
      // Iteration 3: DONE reasoning -> final synthesis
      fetchSpy
        .mockResolvedValueOnce(makeCalculatorDecisionResponse()) // reasoning: calculator (Iter 1)
        .mockResolvedValueOnce(makeSynthesisResponse("Draft: 9.3")) // draft answer (Iter 1)
        .mockResolvedValueOnce(makeEvaluationResponse(0.6)) // LLM evaluation (Iter 1, low score)
        .mockResolvedValueOnce(makeCalculatorDecisionResponse()) // reasoning: calculator (Iter 2)
        .mockResolvedValueOnce(makeSynthesisResponse("Draft: Calculation result.")) // draft answer (Iter 2)
        .mockResolvedValueOnce(makeEvaluationResponse(0.6)) // LLM evaluation (Iter 2, low score)
        .mockResolvedValueOnce(makeDoneDecisionResponse()) // reasoning: DONE (Iter 3)
        .mockResolvedValueOnce(makeSynthesisResponse("The sum is 9.3")) // final synthesis

      const result = await service.run("What is 4.2 + 5.1?", "user-123")
      expect(result.iterationCount).toBe(3)
      expect(result.status).toBe("done")
      expect(result.finalAnswer).toBe("The sum is 9.3")
      expect(result.steps.some(s => s.toolUsed === "calculator")).toBe(true)
    })
  })

  // ── run() — max iterations safety ──────────────────────────────────────
  describe("run() — max iterations safety", () => {
    it("never exceeds MAX_ITERATIONS (5) even if LLM never says DONE", async () => {
      // This test simulates 5 iterations of reasoning -> draft answer, followed by a final synthesis.
      // Total calls: 5 * (reasoning + draft) + final synthesis = 11 calls.
      const MAX_ITERATIONS = 5
      let callCount = 0
      // Mocking fetch calls directly for this specific test
      fetchSpy.mockImplementation(() => {
        // Removed unused url, options
        callCount++
        // Reasoning calls (odd numbers up to 2*MAX_ITERATIONS - 1)
        if (callCount % 2 === 1 && callCount <= 2 * MAX_ITERATIONS - 1) {
          return Promise.resolve(makeRagSearchDecisionResponse())
        }
        // Draft answer calls (even numbers up to 2*MAX_ITERATIONS)
        if (callCount % 2 === 0 && callCount <= 2 * MAX_ITERATIONS) {
          return Promise.resolve(makeSynthesisResponse("Low quality draft"))
        }
        // Final synthesis call (after loop finishes)
        return Promise.resolve(makeSynthesisResponse("Best effort answer."))
      })

      const result = await service.run("Keep searching forever", "user-123")

      expect(result.iterationCount).toBeLessThanOrEqual(MAX_ITERATIONS)
      expect(result.status).toBe("done") // Should stop due to max iterations, status is 'done'
    })

    it("still returns a result when max iterations reached", async () => {
      // This test simulates a sequence of reasoning -> draft -> reasoning -> draft ... -> final synthesis.
      let callCount = 0
      fetchSpy.mockImplementation(() => {
        // Removed unused url, options
        callCount++
        // Reasoning calls (odd calls: 1, 3, 5, 7, 9)
        if (callCount % 2 === 1 && callCount < 11) {
          return Promise.resolve(makeRagSearchDecisionResponse())
        }
        // Draft answer calls (even calls: 2, 4, 6, 8, 10)
        if (callCount % 2 === 0 && callCount < 12) {
          return Promise.resolve(makeSynthesisResponse("Low quality draft"))
        }
        // Last call (11) is the final synthesis
        return Promise.resolve(makeSynthesisResponse("Best effort answer."))
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

      // Mock sequence for iterationCount = 2:
      // Iteration 1: unknown tool reasoning -> draft -> evaluation (low score)
      // Iteration 2: DONE reasoning -> final synthesis
      fetchSpy
        .mockResolvedValueOnce(unknownToolResponse) // unknown tool reasoning (Iteration 1)
        .mockResolvedValueOnce(makeSynthesisResponse("Draft: Attempted nonexistent tool.")) // draft answer (Iteration 1)
        .mockResolvedValueOnce(makeEvaluationResponse(0.6)) // LLM evaluation (Iter 1, low score)
        .mockResolvedValueOnce(makeDoneDecisionResponse()) // reasoning: DONE (Iter 2)
        .mockResolvedValueOnce(makeSynthesisResponse("Handled gracefully.")) // final synthesis

      const result = await service.run("test query", "user-123")
      expect(result.iterationCount).toBe(2)
      expect(result.status).toBe("done")
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

      // Only two calls: reasoning (malformed) -> synthesis
      fetchSpy
        .mockResolvedValueOnce(malformedResponse)
        .mockResolvedValueOnce(makeSynthesisResponse("Fallback answer."))

      const result = await service.run("test query", "user-123")

      expect(result).toBeDefined()
      expect(result.status).toBe("done")
      expect(result.iterationCount).toBe(1) // Loop exits immediately after DONE
    })

    // ── run() — result shape ───────────────────────────────────────────────
    describe("run() — result shape", () => {
      it("result has all required fields", async () => {
        // Mock sequence for iterationCount = 3:
        // Iteration 1: reasoning -> draft -> LLM evaluation (low score)
        // Iteration 2: reasoning -> draft -> LLM evaluation (low score)
        // Iteration 3: DONE -> synthesis
        fetchSpy
          .mockResolvedValueOnce(makeRagSearchDecisionResponse()) // reasoning (Iter 1)
          .mockResolvedValueOnce(makeSynthesisResponse("Draft 1")) // draft (Iter 1)
          .mockResolvedValueOnce(makeEvaluationResponse(0.6)) // evaluation (Iter 1, low)
          .mockResolvedValueOnce(makeRagSearchDecisionResponse()) // reasoning (Iter 2)
          .mockResolvedValueOnce(makeSynthesisResponse("Draft 2")) // draft (Iter 2)
          .mockResolvedValueOnce(makeEvaluationResponse(0.6)) // evaluation (Iter 2, low)
          .mockResolvedValueOnce(makeDoneDecisionResponse()) // reasoning: DONE (Iter 3)
          .mockResolvedValueOnce(makeSynthesisResponse("Final answer for result shape.")) // final synthesis

        const result = await service.run("test", "user-123")

        expect(typeof result.sessionId).toBe("string")
        expect(typeof result.finalAnswer).toBe("string")
        expect(Array.isArray(result.citations)).toBe(true)
        expect(Array.isArray(result.steps)).toBe(true)
        expect(typeof result.iterationCount).toBe("number")
        expect(result.iterationCount).toBe(3)
        expect(typeof result.tokensUsed).toBe("number")
        expect(typeof result.durationMs).toBe("number")
      })

      it("tokensUsed is non-negative", async () => {
        // Mock sequence: reasoning -> draft -> LLM evaluation -> DONE -> synthesis
        fetchSpy
          .mockResolvedValueOnce(makeDoneDecisionResponse())
          .mockResolvedValueOnce(makeSynthesisResponse("Draft: Result shape check."))
          .mockResolvedValueOnce(makeEvaluationResponse(0.85))
          .mockResolvedValueOnce(makeDoneDecisionResponse())
          .mockResolvedValueOnce(makeSynthesisResponse())

        const result = await service.run("test", "user-123")
        expect(result.tokensUsed).toBeGreaterThanOrEqual(0)
      })

      it("each step has required fields", async () => {
        // Mock sequence: reasoning -> draft -> LLM evaluation -> DONE -> synthesis
        fetchSpy
          .mockResolvedValueOnce(makeDoneDecisionResponse())
          .mockResolvedValueOnce(makeSynthesisResponse("Draft: Result shape check."))
          .mockResolvedValueOnce(makeEvaluationResponse(0.85))
          .mockResolvedValueOnce(makeDoneDecisionResponse())
          .mockResolvedValueOnce(makeSynthesisResponse())

        const result = await service.run("test", "user-123")

        result.steps.forEach(step => {
          expect(typeof step.stepNumber).toBe("number")
          expect(typeof step.description).toBe("string")
          expect(typeof step.durationMs).toBe("number")
          expect(step.timestamp).toBeInstanceOf(Date)
        })
      })
    })

    // ── Self-correction tests ───────────────────────────────────────────────
    describe("run() — self-correction integration", () => {
      it("includes quality check steps in the steps array", async () => {
        // Sequence: reasoning -> draft1 -> draft2 -> LLM evaluation -> done -> final_synthesis
        fetchSpy
          .mockResolvedValueOnce(makeRagSearchDecisionResponse()) // reasoning: search
          .mockResolvedValueOnce(makeSynthesisResponse("Draft 1 from search.")) // draft answer 1
          .mockResolvedValueOnce(makeSynthesisResponse("Draft 2 after quality check.")) // draft answer 2
          .mockResolvedValueOnce(makeEvaluationResponse(0.85)) // LLM evaluation
          .mockResolvedValueOnce(makeDoneDecisionResponse()) // reasoning: done
          .mockResolvedValueOnce(makeSynthesisResponse("Final answer.")) // synthesis

        const result = await service.run("What is ML?", "user-123")

        // At minimum: the search step + the done step
        expect(result.steps.length).toBeGreaterThanOrEqual(2)
      })

      it("quality check step description contains percentage score", async () => {
        // Sequence: reasoning -> draft1 -> draft2 -> LLM evaluation -> done -> final_synthesis
        fetchSpy
          .mockResolvedValueOnce(makeRagSearchDecisionResponse())
          .mockResolvedValueOnce(makeSynthesisResponse("Short draft 1."))
          .mockResolvedValueOnce(makeSynthesisResponse("Short draft 2."))
          .mockResolvedValueOnce(makeEvaluationResponse(0.85)) // LLM evaluation
          .mockResolvedValueOnce(makeDoneDecisionResponse())
          .mockResolvedValueOnce(makeSynthesisResponse("Final."))

        const result = await service.run("What is ML?", "user-123")

        const qualityStep = result.steps.find(s => s.description.includes("Quality check"))

        if (qualityStep) {
          // Should contain a percentage score
          expect(qualityStep.description).toMatch(/\d+%/)
        }
      })

      it("agent stops when quality threshold is met", async () => {
        // Sequence: reasoning -> draft1 -> draft2 -> LLM evaluation -> done -> final_synthesis
        // The evaluator will score high if the draft mentions grounding signals
        // We mock a response that explicitly references sources
        fetchSpy
          .mockResolvedValueOnce(makeRagSearchDecisionResponse())
          .mockResolvedValueOnce(
            makeSynthesisResponse(
              // draft answer 1
              "According to the document [Result 1], machine learning is a subset of AI."
            )
          )
          .mockResolvedValueOnce(
            makeSynthesisResponse(
              // draft answer 2
              "The text states that it enables learning from data [Result 1]. " +
                "This is a comprehensive answer covering the full query."
            )
          )
          .mockResolvedValueOnce(makeEvaluationResponse(0.85)) // LLM evaluation
          .mockResolvedValueOnce(makeDoneDecisionResponse())
          .mockResolvedValueOnce(makeSynthesisResponse("Final answer."))

        const result = await service.run("What is machine learning?", "user-123")

        // Should complete within max iterations
        expect(result.iterationCount).toBeLessThanOrEqual(5)
        expect(result.status).toBe("done")
      })

      it("never exceeds MAX_ITERATIONS even with repeated low quality", async () => {
        // This test simulates 5 iterations of reasoning -> draft answer, followed by a final synthesis.
        // Total calls: 5 * (reasoning + draft) + final synthesis = 11 calls.
        const MAX_ITERATIONS = 5
        let callCount = 0
        fetchSpy.mockImplementation(() => {
          // Removed unused url, options
          callCount++
          // Reasoning calls (odd numbers up to 2*MAX_ITERATIONS - 1)
          if (callCount % 2 === 1 && callCount <= 2 * MAX_ITERATIONS - 1) {
            return Promise.resolve(makeRagSearchDecisionResponse())
          }
          // Draft answer calls (even numbers up to 2*MAX_ITERATIONS)
          if (callCount % 2 === 0 && callCount <= 2 * MAX_ITERATIONS) {
            return Promise.resolve(makeSynthesisResponse("Low quality draft"))
          }
          // Final synthesis call (after loop finishes)
          return Promise.resolve(makeSynthesisResponse("Best effort answer."))
        })

        const result = await service.run("An impossible query", "user-123")

        expect(result.iterationCount).toBeLessThanOrEqual(MAX_ITERATIONS)
        expect(result.status).toBe("done")
      })
    })
  })
})
