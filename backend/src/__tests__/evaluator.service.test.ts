// backend/src/__tests__/evaluator.service.test.ts
// Tests for EvaluatorService.
// All three Gemini evaluation calls are mocked.

import { EvaluatorService } from "../services/evaluator.service"

// ── Mock Factories ────────────────────────────────────────────────────────

function makeScoreResponse(score: number, explanation: string): Response {
  const body = {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify({ score, explanation }) }],
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
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const SAMPLE_QUERY = "What is machine learning?"
const SAMPLE_CONTEXT = [
  "Machine learning is a subset of artificial intelligence.",
  "It enables systems to learn from data without explicit programming.",
]
const SAMPLE_ANSWER = "Machine learning is a subset of AI [Source 1]."

// ── Tests ─────────────────────────────────────────────────────────────────
describe("EvaluatorService", () => {
  let service: EvaluatorService
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    service = new EvaluatorService("fake-api-key")
    fetchSpy = jest.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  // ── Constructor ────────────────────────────────────────────────────────
  describe("constructor", () => {
    it("throws for empty API key", () => {
      expect(() => new EvaluatorService("")).toThrow("EvaluatorService requires a Gemini API key")
    })

    it("does not throw for valid key", () => {
      expect(() => new EvaluatorService("valid-key")).not.toThrow()
    })
  })

  // ── evaluate() — happy path ────────────────────────────────────────────
  describe("evaluate() — happy path", () => {
    beforeEach(() => {
      // Three Gemini calls: contextRelevance, faithfulness, answerRelevance
      fetchSpy
        .mockResolvedValueOnce(makeScoreResponse(0.9, "Context is highly relevant"))
        .mockResolvedValueOnce(makeScoreResponse(0.85, "All claims are supported"))
        .mockResolvedValueOnce(makeScoreResponse(0.95, "Directly addresses the query"))
    })

    it("returns an EvalResult with all required fields", async () => {
      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      expect(typeof result.evalId).toBe("string")
      expect(result.evalId.length).toBeGreaterThan(0)
      expect(result.scores).toBeDefined()
      expect(result.feedback).toBeDefined()
      expect(result.recommendations).toBeDefined()
      expect(Array.isArray(result.recommendations)).toBe(true)
      expect(typeof result.evaluatedAt).toBe("string")
      expect(typeof result.durationMs).toBe("number")
      expect(result.model).toBe("gemini-2.0-flash")
    })

    it("returns correct dimension scores", async () => {
      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      expect(result.scores.contextRelevance).toBeCloseTo(0.9, 2)
      expect(result.scores.faithfulness).toBeCloseTo(0.85, 2)
      expect(result.scores.answerRelevance).toBeCloseTo(0.95, 2)
    })

    it("computes overallScore as average of three dimensions", async () => {
      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      const expected = (0.9 + 0.85 + 0.95) / 3
      expect(result.scores.overallScore).toBeCloseTo(expected, 2)
    })

    it("makes exactly three Gemini calls (one per dimension)", async () => {
      await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it("feedback contains explanation for each dimension", async () => {
      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      expect(typeof result.feedback.contextRelevance).toBe("string")
      expect(typeof result.feedback.faithfulness).toBe("string")
      expect(typeof result.feedback.answerRelevance).toBe("string")
      expect(typeof result.feedback.overallAssessment).toBe("string")
    })

    it("all scores are between 0 and 1", async () => {
      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      expect(result.scores.contextRelevance).toBeGreaterThanOrEqual(0)
      expect(result.scores.contextRelevance).toBeLessThanOrEqual(1)
      expect(result.scores.faithfulness).toBeGreaterThanOrEqual(0)
      expect(result.scores.faithfulness).toBeLessThanOrEqual(1)
      expect(result.scores.answerRelevance).toBeGreaterThanOrEqual(0)
      expect(result.scores.answerRelevance).toBeLessThanOrEqual(1)
      expect(result.scores.overallScore).toBeGreaterThanOrEqual(0)
      expect(result.scores.overallScore).toBeLessThanOrEqual(1)
    })
  })

  // ── Recommendations ────────────────────────────────────────────────────
  describe("evaluate() — recommendations", () => {
    it("recommends improving context relevance when score is low", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeScoreResponse(0.2, "Context is not relevant"))
        .mockResolvedValueOnce(makeScoreResponse(0.9, "Faithful"))
        .mockResolvedValueOnce(makeScoreResponse(0.9, "Relevant"))

      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      const hasContextRec = result.recommendations.some(r =>
        r.toLowerCase().includes("context relevance")
      )
      expect(hasContextRec).toBe(true)
    })

    it("recommends improving faithfulness when score is low", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeScoreResponse(0.9, "Relevant"))
        .mockResolvedValueOnce(makeScoreResponse(0.2, "Answer contains hallucinations"))
        .mockResolvedValueOnce(makeScoreResponse(0.9, "Addresses query"))

      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      const hasFaithfulnessRec = result.recommendations.some(r =>
        r.toLowerCase().includes("faithfulness")
      )
      expect(hasFaithfulnessRec).toBe(true)
    })

    it("provides positive recommendation when all scores are high", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeScoreResponse(0.95, "Excellent context"))
        .mockResolvedValueOnce(makeScoreResponse(0.9, "Fully faithful"))
        .mockResolvedValueOnce(makeScoreResponse(0.92, "Highly relevant"))

      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      expect(result.recommendations.length).toBeGreaterThan(0)
      const hasPositive = result.recommendations[0]?.toLowerCase().includes("above threshold")
      expect(hasPositive).toBe(true)
    })
  })

  // ── Overall Assessment ─────────────────────────────────────────────────
  describe("evaluate() — overall assessment", () => {
    it("says 'Excellent' when all scores >= 0.85", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeScoreResponse(0.9, "High"))
        .mockResolvedValueOnce(makeScoreResponse(0.88, "High"))
        .mockResolvedValueOnce(makeScoreResponse(0.92, "High"))

      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      expect(result.feedback.overallAssessment.toLowerCase()).toContain("excellent")
    })

    it("mentions weakest dimension when overall is moderate", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeScoreResponse(0.75, "Good"))
        .mockResolvedValueOnce(makeScoreResponse(0.45, "Low faithfulness"))
        .mockResolvedValueOnce(makeScoreResponse(0.8, "Good"))

      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      // Faithfulness is weakest — should be mentioned
      expect(result.feedback.overallAssessment.toLowerCase()).toContain("faithfulness")
    })
  })

  // ── Error handling ─────────────────────────────────────────────────────
  describe("evaluate() — error handling", () => {
    it("returns neutral score when Gemini call fails", async () => {
      // All three calls fail
      fetchSpy.mockRejectedValue(new Error("API unavailable"))

      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      // Should not throw — neutral scores returned
      expect(result.scores.contextRelevance).toBeCloseTo(0.5, 1)
      expect(result.scores.faithfulness).toBeCloseTo(0.5, 1)
      expect(result.scores.answerRelevance).toBeCloseTo(0.5, 1)
    })

    it("handles malformed JSON from Gemini", async () => {
      const malformedResponse = new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "The score is about 0.7 because the content is relevant" }],
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

      fetchSpy.mockResolvedValue(malformedResponse)

      const result = await service.evaluate({
        query: SAMPLE_QUERY,
        retrievedContext: SAMPLE_CONTEXT,
        answer: SAMPLE_ANSWER,
      })

      // Should extract a number from unstructured text or use neutral
      expect(result.scores.contextRelevance).toBeGreaterThanOrEqual(0)
      expect(result.scores.contextRelevance).toBeLessThanOrEqual(1)
    })
  })

  // ── evaluateBatch() ────────────────────────────────────────────────────
  describe("evaluateBatch()", () => {
    it("returns aggregate scores across all pairs", async () => {
      // Two pairs: each needs 3 Gemini calls = 6 total
      fetchSpy
        .mockResolvedValueOnce(makeScoreResponse(0.9, "Good context 1"))
        .mockResolvedValueOnce(makeScoreResponse(0.8, "Faithful 1"))
        .mockResolvedValueOnce(makeScoreResponse(0.85, "Relevant 1"))
        .mockResolvedValueOnce(makeScoreResponse(0.7, "Good context 2"))
        .mockResolvedValueOnce(makeScoreResponse(0.6, "Faithful 2"))
        .mockResolvedValueOnce(makeScoreResponse(0.75, "Relevant 2"))

      const result = await service.evaluateBatch({
        pairs: [
          {
            query: "Question 1",
            retrievedContext: ["Context 1"],
            answer: "Answer 1",
          },
          {
            query: "Question 2",
            retrievedContext: ["Context 2"],
            answer: "Answer 2",
          },
        ],
      })

      expect(result.results).toHaveLength(2)
      expect(result.aggregateScores).toBeDefined()
      expect(result.aggregateScores.contextRelevance).toBeCloseTo((0.9 + 0.7) / 2, 2)
    })

    it("returns bestDimension and worstDimension", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeScoreResponse(0.9, "High"))
        .mockResolvedValueOnce(makeScoreResponse(0.5, "Low"))
        .mockResolvedValueOnce(makeScoreResponse(0.7, "Medium"))

      const result = await service.evaluateBatch({
        pairs: [
          {
            query: "test",
            retrievedContext: ["context"],
            answer: "answer",
          },
        ],
      })

      expect(result.bestDimension).toBeDefined()
      expect(result.worstDimension).toBeDefined()
      // contextRelevance is highest (0.9), faithfulness is lowest (0.5)
      expect(result.bestDimension).toBe("contextRelevance")
      expect(result.worstDimension).toBe("faithfulness")
    })

    it("totalDurationMs is positive", async () => {
      fetchSpy.mockResolvedValue(makeScoreResponse(0.8, "Good"))

      const result = await service.evaluateBatch({
        pairs: [
          {
            query: "test",
            retrievedContext: ["context"],
            answer: "answer",
          },
        ],
      })

      expect(result.totalDurationMs).toBeGreaterThan(0)
    })
  })
})
