import crypto from "crypto"
import type { GeminiRequest, GeminiResponse } from "../types/llm.types"
import type {
  EvalRequest,
  EvalResult,
  EvalFeedback,
  RagTriadScore,
  BatchEvalRequest,
  BatchEvalResult,
} from "../types/eval.types"
import { logRagEvent, logError } from "../utils/logger"
import { ragTriadScores } from "../utils/metrics"

// ── Constants ──────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

// Weights for the overall score
// All three dimensions are equally important by default.
// In some RAG systems faithfulness is weighted higher (anti-hallucination priority).
const DIMENSION_WEIGHTS = {
  contextRelevance: 1 / 3,
  faithfulness: 1 / 3,
  answerRelevance: 1 / 3,
} as const

export class EvaluatorService {
  constructor(private readonly apiKey: string) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error("EvaluatorService requires a Gemini API key")
    }
  }

  // ── evaluate ──────────────────────────────────────────────────────────
  // Evaluates one query-answer pair on all three RAG Triad dimensions.
  // Returns scores, explanations, and improvement recommendations.
  async evaluate(request: EvalRequest): Promise<EvalResult> {
    const start = Date.now()
    const evalId = crypto.randomUUID()

    logRagEvent("ingest", "RAG Triad evaluation started", {
      service: "EvaluatorService",
      userId: evalId,
    })

    // Run all three evaluations in parallel — faster than sequential
    const contextText = request.retrievedContext.join("\n\n---\n\n")

    const [contextResult, faithfulnessResult, answerResult] = await Promise.all([
      this.evaluateContextRelevance(request.query, contextText),
      this.evaluateFaithfulness(request.answer, contextText),
      this.evaluateAnswerRelevance(request.query, request.answer),
    ])

    // Compute weighted overall score
    const overallScore =
      contextResult.score * DIMENSION_WEIGHTS.contextRelevance +
      faithfulnessResult.score * DIMENSION_WEIGHTS.faithfulness +
      answerResult.score * DIMENSION_WEIGHTS.answerRelevance

    const scores: RagTriadScore = {
      contextRelevance: contextResult.score,
      faithfulness: faithfulnessResult.score,
      answerRelevance: answerResult.score,
      overallScore: Math.round(overallScore * 100) / 100, // round to 2dp
    }

    const feedback: EvalFeedback = {
      contextRelevance: contextResult.explanation,
      faithfulness: faithfulnessResult.explanation,
      answerRelevance: answerResult.explanation,
      overallAssessment: this.buildOverallAssessment(scores),
    }

    const recommendations = this.buildRecommendations(scores)

    // Record in Prometheus metrics
    ragTriadScores.labels("context_relevance").observe(scores.contextRelevance)
    ragTriadScores.labels("faithfulness").observe(scores.faithfulness)
    ragTriadScores.labels("answer_relevance").observe(scores.answerRelevance)

    const durationMs = Date.now() - start

    logRagEvent("ingest", "RAG Triad evaluation complete", {
      service: "EvaluatorService",
      similarity: scores.overallScore,
      durationMs,
    })

    return {
      evalId,
      scores,
      feedback,
      recommendations,
      evaluatedAt: new Date().toISOString(),
      durationMs,
      model: GEMINI_MODEL,
    }
  }

  // ── evaluateBatch ─────────────────────────────────────────────────────
  // Evaluates multiple query-answer pairs and returns aggregate statistics.
  // Use this for systematic pipeline comparison.
  async evaluateBatch(request: BatchEvalRequest): Promise<BatchEvalResult> {
    const start = Date.now()
    const results: EvalResult[] = []

    // Evaluate pairs sequentially to avoid rate limits
    for (const pair of request.pairs) {
      const result = await this.evaluate({
        ...pair,
        pipelineVersion: request.pipelineVersion ?? pair.pipelineVersion,
      })
      results.push(result)
    }

    // Compute aggregate scores
    const aggregate = this.aggregateScores(results)

    // Find best and worst dimensions
    const dimensions: Array<keyof RagTriadScore> = [
      "contextRelevance",
      "faithfulness",
      "answerRelevance",
    ]

    const dimScores = dimensions.map(d => ({
      dim: d,
      score: aggregate[d],
    }))

    dimScores.sort((a, b) => b.score - a.score)

    const bestDimension = dimScores[0]?.dim ?? "overallScore"
    const worstDimension = dimScores[dimScores.length - 1]?.dim ?? "overallScore"

    return {
      results,
      aggregateScores: aggregate,
      bestDimension,
      worstDimension,
      totalDurationMs: Date.now() - start,
    }
  }

  // ── comparePipelines ──────────────────────────────────────────────────
  // Compares two pipeline configurations on the same test set.
  // Use this to measure the impact of changes (reranker, chunk size, etc.)
  async comparePipelines(
    testPairs: Array<{ query: string; context: string[]; answer: string }>,
    versionA: string,
    versionB: string,
    answersB: string[] // answers from pipeline version B for the same queries
  ): Promise<{ versionA: RagTriadScore; versionB: RagTriadScore; winner: string }> {
    const pairsA = testPairs.map(pair => ({
      query: pair.query,
      retrievedContext: pair.context,
      answer: pair.answer,
    }))

    const pairsB = testPairs.map((pair, i) => ({
      query: pair.query,
      retrievedContext: pair.context,
      answer: answersB[i] ?? pair.answer,
    }))

    const [batchA, batchB] = await Promise.all([
      this.evaluateBatch({ pairs: pairsA, pipelineVersion: versionA }),
      this.evaluateBatch({ pairs: pairsB, pipelineVersion: versionB }),
    ])

    const winner =
      batchA.aggregateScores.overallScore >= batchB.aggregateScores.overallScore
        ? versionA
        : versionB

    return {
      versionA: batchA.aggregateScores,
      versionB: batchB.aggregateScores,
      winner,
    }
  }

  // ── Private: Evaluate Context Relevance ───────────────────────────────
  // Asks the LLM: "Do these retrieved chunks address this query?"
  private async evaluateContextRelevance(
    query: string,
    context: string
  ): Promise<{ score: number; explanation: string }> {
    const prompt = `You are a RAG system quality evaluator.

TASK: Evaluate whether the RETRIEVED CONTEXT is relevant to the QUERY.

QUERY:
"${query}"

RETRIEVED CONTEXT:
${context.slice(0, 2000)}

SCORING RUBRIC for Context Relevance:
0.0-0.2: Context is completely unrelated to the query
0.3-0.4: Context is only tangentially related
0.5-0.6: Context partially addresses the query topic
0.7-0.8: Context is mostly relevant, minor gaps
0.9-1.0: Context is highly relevant and directly addresses the query

WHAT TO LOOK FOR:
- Does the context contain information about what the query asks?
- Are the retrieved chunks from the right topic/domain?
- Is there noise (irrelevant chunks mixed in with relevant ones)?

Respond ONLY with valid JSON:
{
  "score": 0.0,
  "explanation": "One sentence explaining why this score was assigned"
}`

    return this.callAndParse(prompt)
  }

  // ── Private: Evaluate Faithfulness ────────────────────────────────────
  // Asks the LLM: "Is everything in the answer backed by the context?"
  private async evaluateFaithfulness(
    answer: string,
    context: string
  ): Promise<{ score: number; explanation: string }> {
    const prompt = `You are a RAG system quality evaluator.

TASK: Evaluate whether the ANSWER is faithful to the RETRIEVED CONTEXT.
Faithfulness means every claim in the answer is supported by the context.
An unfaithful answer contains claims NOT present in the context (hallucination).

ANSWER:
"${answer}"

RETRIEVED CONTEXT:
${context.slice(0, 2000)}

SCORING RUBRIC for Faithfulness:
0.0-0.2: Answer contains major claims not in the context (clear hallucination)
0.3-0.4: Answer contains some unsupported claims
0.5-0.6: Most claims are supported but some cannot be verified
0.7-0.8: Nearly all claims are supported by the context
0.9-1.0: Every claim in the answer is directly supported by the context

WHAT TO LOOK FOR:
- Does the answer introduce facts not mentioned in the context?
- Does the answer accurately represent what the context says?
- Does the answer say "I don't have information" when context is insufficient?
  (This should score HIGH — honesty is faithful behaviour)

Respond ONLY with valid JSON:
{
  "score": 0.0,
  "explanation": "One sentence explaining which claims were or were not supported"
}`

    return this.callAndParse(prompt)
  }

  // ── Private: Evaluate Answer Relevance ───────────────────────────────
  // Asks the LLM: "Does the answer actually address what was asked?"
  private async evaluateAnswerRelevance(
    query: string,
    answer: string
  ): Promise<{ score: number; explanation: string }> {
    const prompt = `You are a RAG system quality evaluator.

TASK: Evaluate whether the ANSWER is relevant to and directly addresses the QUERY.
Note: Do NOT evaluate factual accuracy here — only whether the answer addresses the question.

QUERY:
"${query}"

ANSWER:
"${answer}"

SCORING RUBRIC for Answer Relevance:
0.0-0.2: Answer completely ignores the question
0.3-0.4: Answer vaguely relates to the topic but does not address the question
0.5-0.6: Answer partially addresses the question
0.7-0.8: Answer mostly answers the question with minor omissions
0.9-1.0: Answer directly and completely addresses the question

WHAT TO LOOK FOR:
- Does the answer respond to what was specifically asked?
- Is the answer focused on the query or does it wander off-topic?
- If the answer says "I don't have enough information" — this is relevant
  IF the system genuinely doesn't have the information (score 0.7).
  It's irrelevant IF the context clearly contained the answer (score 0.2).

Respond ONLY with valid JSON:
{
  "score": 0.0,
  "explanation": "One sentence explaining how well the answer addressed the query"
}`

    return this.callAndParse(prompt)
  }

  // ── Private: Call Gemini and parse score ──────────────────────────────
  private async callAndParse(prompt: string): Promise<{ score: number; explanation: string }> {
    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1, // deterministic scoring
        topP: 1.0,
        maxOutputTokens: 256,
      },
    }

    try {
      const response = await this.callGemini(requestBody)
      const rawText = response.candidates[0]?.content.parts[0]?.text ?? ""
      return this.parseScoreResponse(rawText)
    } catch (error: unknown) {
      logError("Evaluation call failed", error, { service: "EvaluatorService" })
      // Return neutral score on failure — does not crash the evaluation
      return { score: 0.5, explanation: "Evaluation unavailable — using neutral score" }
    }
  }

  // ── Private: Parse Score Response ─────────────────────────────────────
  private parseScoreResponse(rawText: string): { score: number; explanation: string } {
    const cleaned = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim()

    try {
      const parsed = JSON.parse(cleaned) as {
        score?: unknown
        explanation?: unknown
      }

      const score = Math.max(0, Math.min(1, Number(parsed.score ?? 0.5)))
      const explanation =
        typeof parsed.explanation === "string" ? parsed.explanation : "No explanation provided"

      if (isNaN(score)) return { score: 0.5, explanation }

      return { score, explanation }
    } catch {
      // Extract a number from the text as fallback
      const numMatch = rawText.match(/\b(0?\.\d+|[01]\.?\d*)\b/)
      const score = numMatch ? Math.max(0, Math.min(1, parseFloat(numMatch[1] ?? "0.5"))) : 0.5

      return {
        score,
        explanation: "Score extracted from unstructured response",
      }
    }
  }

  // ── Private: Build Overall Assessment ────────────────────────────────
  private buildOverallAssessment(scores: RagTriadScore): string {
    const { overallScore } = scores

    if (overallScore >= 0.85) {
      return "Excellent RAG quality — all three dimensions score well above threshold."
    }

    if (overallScore >= 0.7) {
      const weakest = this.findWeakestDimension(scores)
      return (
        `Good RAG quality (${(overallScore * 100).toFixed(0)}%). ` +
        `${weakest} is the weakest dimension and should be prioritised.`
      )
    }

    if (overallScore >= 0.5) {
      const weakest = this.findWeakestDimension(scores)
      return (
        `Moderate RAG quality (${(overallScore * 100).toFixed(0)}%). ` +
        `${weakest} is the weakest dimension. Multiple dimensions need improvement — see recommendations.`
      )
    }

    return (
      `Low RAG quality (${(overallScore * 100).toFixed(0)}%). ` +
      `The pipeline has significant issues. Review retrieval and prompt configuration.`
    )
  }

  // ── Private: Build Recommendations ────────────────────────────────────
  private buildRecommendations(scores: RagTriadScore): string[] {
    const recs: string[] = []

    if (scores.contextRelevance < 0.6) {
      recs.push(
        "Context Relevance is low — try increasing topK to retrieve more candidates, " +
          "experiment with smaller chunk sizes (256 chars), or tune the hybrid search weights."
      )
    }

    if (scores.faithfulness < 0.7) {
      recs.push(
        "Faithfulness is low — the LLM may be using knowledge beyond the retrieved context. " +
          "Strengthen the system prompt: add 'You MUST NOT use any knowledge not in the context below.' " +
          "Also try lowering temperature to 0.05."
      )
    }

    if (scores.answerRelevance < 0.7) {
      recs.push(
        "Answer Relevance is low — the answer may be off-topic or too generic. " +
          "Check that the user query is passed to the synthesis prompt verbatim. " +
          "Consider adding 'Answer ONLY the specific question asked.' to the prompt."
      )
    }

    if (scores.contextRelevance >= 0.8 && scores.faithfulness < 0.7) {
      recs.push(
        "Good retrieval but low faithfulness — the LLM is ignoring the retrieved context. " +
          "The system prompt grounding instruction may not be strong enough."
      )
    }

    if (recs.length === 0) {
      recs.push(
        "All scores are above threshold. " +
          "To further improve: try the reranker (POST /rag/query-with-rerank) " +
          "and measure whether it raises context relevance scores."
      )
    }

    return recs
  }

  // ── Private: Find Weakest Dimension ──────────────────────────────────
  private findWeakestDimension(scores: RagTriadScore): string {
    const dims = [
      { name: "Context Relevance", score: scores.contextRelevance },
      { name: "Faithfulness", score: scores.faithfulness },
      { name: "Answer Relevance", score: scores.answerRelevance },
    ]
    dims.sort((a, b) => a.score - b.score)
    return dims[0]?.name ?? "Context Relevance"
  }

  // ── Private: Aggregate Scores ─────────────────────────────────────────
  private aggregateScores(results: EvalResult[]): RagTriadScore {
    if (results.length === 0) {
      return { contextRelevance: 0, faithfulness: 0, answerRelevance: 0, overallScore: 0 }
    }

    const sum = results.reduce(
      (acc, r) => ({
        contextRelevance: acc.contextRelevance + r.scores.contextRelevance,
        faithfulness: acc.faithfulness + r.scores.faithfulness,
        answerRelevance: acc.answerRelevance + r.scores.answerRelevance,
        overallScore: acc.overallScore + r.scores.overallScore,
      }),
      { contextRelevance: 0, faithfulness: 0, answerRelevance: 0, overallScore: 0 }
    )

    const n = results.length
    return {
      contextRelevance: Math.round((sum.contextRelevance / n) * 100) / 100,
      faithfulness: Math.round((sum.faithfulness / n) * 100) / 100,
      answerRelevance: Math.round((sum.answerRelevance / n) * 100) / 100,
      overallScore: Math.round((sum.overallScore / n) * 100) / 100,
    }
  }

  // ── Private: Call Gemini ──────────────────────────────────────────────
  private async callGemini(requestBody: GeminiRequest): Promise<GeminiResponse> {
    const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      throw new Error(`Gemini evaluator API error: ${response.status} ${response.statusText}`)
    }

    return response.json() as Promise<GeminiResponse>
  }
}
