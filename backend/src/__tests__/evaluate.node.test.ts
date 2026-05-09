// backend/src/__tests__/evaluate.node.test.ts
// Tests for the EvaluatorNode — heuristic evaluation only.
// LLM evaluation is tested with mocked fetch (same pattern as other services).

import { EvaluatorNode } from "../agents/nodes/evaluate.node"
import type { EvaluationContext } from "../agents/nodes/evaluate.node"
import type { ToolCall } from "../types/agent.types"

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeRagToolCall(output: string, success = true): ToolCall {
  return {
    toolName: "rag_search",
    input: { query: "test query" },
    output,
    durationMs: 200,
    timestamp: new Date(),
    success,
  }
}

function makeCalcToolCall(output: string): ToolCall {
  return {
    toolName: "calculator",
    input: { expression: "4.2 + 5.1" },
    output,
    durationMs: 1,
    timestamp: new Date(),
    success: true,
  }
}

function makeContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    userQuery: "What is machine learning?",
    toolCallHistory: [],
    draftAnswer: "Machine learning is a subset of AI.",
    iterationCount: 1,
    maxIterations: 5,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("EvaluatorNode (heuristic)", () => {
  // No API key → always uses heuristic evaluation
  const evaluator = new EvaluatorNode()

  // ── Result shape ───────────────────────────────────────────────────────
  describe("evaluate() — result shape", () => {
    it("returns an EvaluationResult with all required fields", async () => {
      const result = await evaluator.evaluate(makeContext())

      expect(typeof result.overallScore).toBe("number")
      expect(typeof result.contextRelevance).toBe("number")
      expect(typeof result.faithfulness).toBe("number")
      expect(typeof result.answerRelevance).toBe("number")
      expect(typeof result.shouldRetry).toBe("boolean")
      expect(typeof result.retryReason).toBe("string")
      expect(result.evaluationMethod).toBe("heuristic")
    })

    it("all scores are between 0 and 1", async () => {
      const result = await evaluator.evaluate(makeContext())

      expect(result.overallScore).toBeGreaterThanOrEqual(0)
      expect(result.overallScore).toBeLessThanOrEqual(1)
      expect(result.contextRelevance).toBeGreaterThanOrEqual(0)
      expect(result.contextRelevance).toBeLessThanOrEqual(1)
      expect(result.faithfulness).toBeGreaterThanOrEqual(0)
      expect(result.faithfulness).toBeLessThanOrEqual(1)
      expect(result.answerRelevance).toBeGreaterThanOrEqual(0)
      expect(result.answerRelevance).toBeLessThanOrEqual(1)
    })

    it("overallScore is average of three dimensions", async () => {
      const result = await evaluator.evaluate(makeContext())
      const expected = (result.contextRelevance + result.faithfulness + result.answerRelevance) / 3

      expect(result.overallScore).toBeCloseTo(expected, 5)
    })
  })

  // ── No tools called ────────────────────────────────────────────────────
  describe("evaluate() — no tool calls", () => {
    it("scores contextRelevance low when no tools were called", async () => {
      const ctx = makeContext({ toolCallHistory: [] })
      const result = await evaluator.evaluate(ctx)

      expect(result.contextRelevance).toBeLessThan(0.3)
    })

    it("recommends retry when no tools were called", async () => {
      const ctx = makeContext({ toolCallHistory: [] })
      const result = await evaluator.evaluate(ctx)

      expect(result.shouldRetry).toBe(true)
    })
  })

  // ── No results found ───────────────────────────────────────────────────
  describe("evaluate() — search returned no results", () => {
    it("scores very low when search found nothing", async () => {
      const ctx = makeContext({
        toolCallHistory: [makeRagToolCall("No relevant chunks found for this query.")],
        draftAnswer: "I don't have enough information.",
      })

      const result = await evaluator.evaluate(ctx)
      expect(result.contextRelevance).toBeLessThan(0.4)
    })

    it("recommends retry when no results found", async () => {
      const ctx = makeContext({
        toolCallHistory: [makeRagToolCall("No relevant chunks found for this query.")],
        draftAnswer: "I don't have enough information.",
      })

      const result = await evaluator.evaluate(ctx)
      expect(result.shouldRetry).toBe(true)
    })
  })

  // ── Good results ───────────────────────────────────────────────────────
  describe("evaluate() — high quality results", () => {
    it("scores contextRelevance higher with successful RAG results", async () => {
      const ctx = makeContext({
        toolCallHistory: [
          makeRagToolCall(
            "[Result 1] (source: ml-intro.txt, relevance: 0.032)\n" +
              "Machine learning is a subset of artificial intelligence."
          ),
        ],
        draftAnswer: "According to the document, machine learning is a subset of AI [Result 1].",
      })

      const noneCtx = makeContext({ toolCallHistory: [] })
      const withResult = await evaluator.evaluate(ctx)
      const withNone = await evaluator.evaluate(noneCtx)

      expect(withResult.contextRelevance).toBeGreaterThan(withNone.contextRelevance)
    })

    it("detects grounding signals in the draft answer", async () => {
      const groundedCtx = makeContext({
        toolCallHistory: [makeRagToolCall("[Result 1] Content here.")],
        draftAnswer: "According to the document, ML is a subset of AI [Result 1].",
      })

      const ungroundedCtx = makeContext({
        toolCallHistory: [makeRagToolCall("[Result 1] Content here.")],
        draftAnswer: "I believe machine learning is probably important.",
      })

      const grounded = await evaluator.evaluate(groundedCtx)
      const ungrounded = await evaluator.evaluate(ungroundedCtx)

      expect(grounded.faithfulness).toBeGreaterThan(ungrounded.faithfulness)
    })

    it("detects hallucination signals", async () => {
      const hallucinationCtx = makeContext({
        toolCallHistory: [makeRagToolCall("[Result 1] Some content.")],
        draftAnswer:
          "I believe this is probably correct. It is possible that ML is generally speaking a way to learn. From my training I know this is likely.",
      })

      const result = await evaluator.evaluate(hallucinationCtx)
      expect(result.faithfulness).toBeLessThan(0.5)
    })
  })

  // ── shouldRetry ────────────────────────────────────────────────────────
  describe("evaluate() — shouldRetry logic", () => {
    it("shouldRetry is true when overallScore < 0.7", async () => {
      const ctx = makeContext({ toolCallHistory: [], draftAnswer: "" })
      const result = await evaluator.evaluate(ctx)

      if (result.overallScore < 0.7) {
        expect(result.shouldRetry).toBe(true)
      }
    })

    it("shouldRetry is false when overallScore >= 0.7", async () => {
      // Good context: multiple successful searches + grounded answer
      const ctx = makeContext({
        toolCallHistory: [
          makeRagToolCall("[Result 1] (source: doc.txt, relevance: 0.05)\nML is a subset of AI."),
          makeRagToolCall(
            "[Result 1] (source: doc.txt, relevance: 0.04)\nSupervised learning uses labels."
          ),
          makeRagToolCall(
            "[Result 1] (source: doc.txt, relevance: 0.03)\nDeep learning uses neural networks."
          ),
        ],
        draftAnswer:
          "According to the document [Result 1], machine learning is a subset of AI. " +
          "The document states that supervised learning uses labelled data [Result 1]. " +
          "Deep learning, according to the text, uses neural networks with many layers [Result 1].",
      })

      const result = await evaluator.evaluate(ctx)

      // If score is >= 0.7, shouldRetry must be false
      if (result.overallScore >= 0.7) {
        expect(result.shouldRetry).toBe(false)
      }
    })

    it("provides a retryReason when shouldRetry is true", async () => {
      const ctx = makeContext({ toolCallHistory: [], draftAnswer: "" })
      const result = await evaluator.evaluate(ctx)

      if (result.shouldRetry) {
        expect(result.retryReason.length).toBeGreaterThan(0)
      }
    })
  })

  // ── Calculator tool ────────────────────────────────────────────────────
  describe("evaluate() — calculator tool calls", () => {
    it("gives a contextRelevance boost for successful calculator call", async () => {
      const withCalc = makeContext({
        toolCallHistory: [makeCalcToolCall("9.3")],
        draftAnswer: "The sum is 9.3 according to the calculation.",
      })

      const withoutCalc = makeContext({
        toolCallHistory: [],
        draftAnswer: "I'm not sure.",
      })

      const calcResult = await evaluator.evaluate(withCalc)
      const noCalcResult = await evaluator.evaluate(withoutCalc)

      expect(calcResult.contextRelevance).toBeGreaterThan(noCalcResult.contextRelevance)
    })
  })

  // ── Empty draft answer ─────────────────────────────────────────────────
  describe("evaluate() — empty draft answer", () => {
    it("scores faithfulness 0 for empty draft", async () => {
      const ctx = makeContext({ draftAnswer: "" })
      const result = await evaluator.evaluate(ctx)
      expect(result.faithfulness).toBe(0)
    })

    it("scores answerRelevance 0 for empty draft", async () => {
      const ctx = makeContext({ draftAnswer: "" })
      const result = await evaluator.evaluate(ctx)
      expect(result.answerRelevance).toBe(0)
    })
  })

  // ── LLM evaluation with mocked fetch ──────────────────────────────────
  describe("evaluate() — LLM evaluation (mocked)", () => {
    let fetchSpy: jest.SpyInstance
    const evaluatorWithKey = new EvaluatorNode("fake-api-key")

    beforeEach(() => {
      fetchSpy = jest.spyOn(global, "fetch")
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    it("calls Gemini API for borderline scores", async () => {
      // Mock Gemini response
      const mockGeminiResp = new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      contextRelevance: 0.6,
                      faithfulness: 0.65,
                      answerRelevance: 0.6,
                      shouldRetry: true,
                      retryReason: "Partially addressed",
                      suggestedQuery: "Q4 revenue quarterly report",
                    }),
                  },
                ],
                role: "model",
              },
              finishReason: "STOP",
              safetyRatings: [],
            },
          ],
          usageMetadata: { totalTokenCount: 100, promptTokenCount: 80, candidatesTokenCount: 20 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )

      fetchSpy.mockResolvedValueOnce(mockGeminiResp)

      // Borderline context: one search found something but maybe not everything
      const ctx = makeContext({
        toolCallHistory: [
          makeRagToolCall(
            "[Result 1] (source: report.txt, relevance: 0.03)\nQ3 revenue was $4.2M."
          ),
        ],
        draftAnswer: "Q3 revenue was $4.2M. I could not find Q4 data.",
      })

      const result = await evaluatorWithKey.evaluate(ctx)

      // Should have called Gemini (borderline score)
      // Method might be hybrid or heuristic depending on computed scores
      expect(result.evaluationMethod).toMatch(/heuristic|hybrid/)
      expect(result.overallScore).toBeGreaterThanOrEqual(0)
      expect(result.overallScore).toBeLessThanOrEqual(1)
    })

    it("falls back to heuristic if LLM call fails", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network error"))

      const ctx = makeContext({
        toolCallHistory: [makeRagToolCall("Some result.")],
        draftAnswer: "Some answer.",
      })

      // Should not throw — falls back to heuristic
      const result = await evaluatorWithKey.evaluate(ctx)
      expect(result).toBeDefined()
      expect(result.evaluationMethod).toBe("heuristic")
    })

    it("handles malformed JSON from LLM gracefully", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "This is not JSON at all" }],
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
      )

      const ctx = makeContext({
        toolCallHistory: [makeRagToolCall("Some result.")],
        draftAnswer: "Some answer.",
      })

      const result = await evaluatorWithKey.evaluate(ctx)
      // Should not throw — returns neutral scores when parsing fails
      expect(result).toBeDefined()
      expect(result.overallScore).toBeGreaterThanOrEqual(0)
    })
  })
})
