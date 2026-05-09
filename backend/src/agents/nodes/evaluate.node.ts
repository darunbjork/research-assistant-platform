/* eslint-disable @typescript-eslint/no-unused-vars */
// backend/src/agents/nodes/evaluate.node.ts
// The self-evaluation component of the ReAct agent.
//
// WHAT IT DOES:
// Given the user's query, the retrieved evidence, and a draft answer,
// evaluates whether the answer is good enough to return to the user.
//
// THREE EVALUATION MODES:
// 1. HEURISTIC (fast, free): rule-based scoring — no LLM call
// 2. LLM-BASED (slower, costs tokens): ask Gemini to score
// 3. HYBRID (recommended): heuristic first, LLM only if borderline
//
// WHY HEURISTIC FIRST?
// Heuristic evaluation catches obvious failures instantly:
//   - "No results found" in output → score = 0.0 immediately
//   - Zero tool calls made → score = 0.1
//   - Draft answer is "I don't know" → score = 0.2
// Only borderline cases (score 0.4-0.8) need the LLM to judge.
// This saves tokens and latency for the majority of cases.

import type { ToolCall } from "../../types/agent.types"
import type { GeminiRequest, GeminiResponse } from "../../types/llm.types"
import { logRagEvent } from "../../utils/logger"
import { ragTriadScores } from "../../utils/metrics"

// ── Types ─────────────────────────────────────────────────────────────────

export interface EvaluationResult {
  overallScore: number // 0-1 composite score
  contextRelevance: number // 0-1 did search find relevant chunks?
  faithfulness: number // 0-1 is draft answer supported by evidence?
  answerRelevance: number // 0-1 does draft answer address the query?
  shouldRetry: boolean // true if score < threshold
  retryReason: string // why retry is recommended
  suggestedQuery?: string // a better search query if retry is needed
  evaluationMethod: "heuristic" | "llm" | "hybrid"
}

export interface EvaluationContext {
  userQuery: string
  toolCallHistory: ToolCall[]
  draftAnswer: string
  iterationCount: number
  maxIterations: number
}

// ── Constants ─────────────────────────────────────────────────────────────

// Score below this threshold triggers a retry
const QUALITY_THRESHOLD = 0.7

// Only use LLM evaluation for borderline scores
const HEURISTIC_LOW_THRESHOLD = 0.3 // below this: definitely retry (no LLM needed)
const HEURISTIC_HIGH_THRESHOLD = 0.85 // above this: definitely done (no LLM needed)

const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

// ── Evaluator Class ───────────────────────────────────────────────────────

export class EvaluatorNode {
  constructor(private readonly apiKey?: string) {}

  // ── evaluate ──────────────────────────────────────────────────────────
  // Main entry point.
  // Uses hybrid evaluation: heuristic first, LLM for borderline cases.
  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    const start = Date.now()

    // ── Step 1: Heuristic evaluation (fast, free) ─────────────────────
    const heuristicResult = this.evaluateHeuristic(context)

    logRagEvent("agent_step", "Heuristic evaluation complete", {
      service: "EvaluatorNode",
      similarity: heuristicResult.overallScore,
    })

    // ── Step 2: If heuristic is conclusive, return immediately ─────────
    if (
      heuristicResult.overallScore <= HEURISTIC_LOW_THRESHOLD ||
      heuristicResult.overallScore >= HEURISTIC_HIGH_THRESHOLD
    ) {
      // Record metrics
      this.recordMetrics(heuristicResult)

      return {
        ...heuristicResult,
        evaluationMethod: "heuristic",
      }
    }

    // ── Step 3: Borderline — use LLM for deeper evaluation ────────────
    if (this.apiKey && this.apiKey.trim() !== "") {
      try {
        const llmResult = await this.evaluateWithLLM(context)

        // Blend heuristic (40%) and LLM (60%) scores for robustness
        const blended: EvaluationResult = {
          contextRelevance:
            0.4 * heuristicResult.contextRelevance + 0.6 * llmResult.contextRelevance,
          faithfulness: 0.4 * heuristicResult.faithfulness + 0.6 * llmResult.faithfulness,
          answerRelevance: 0.4 * heuristicResult.answerRelevance + 0.6 * llmResult.answerRelevance,
          overallScore: 0,
          shouldRetry: false,
          retryReason: "",
          suggestedQuery: llmResult.suggestedQuery,
          evaluationMethod: "hybrid",
        }

        blended.overallScore =
          (blended.contextRelevance + blended.faithfulness + blended.answerRelevance) / 3

        blended.shouldRetry = blended.overallScore < QUALITY_THRESHOLD
        blended.retryReason = blended.shouldRetry
          ? llmResult.retryReason || heuristicResult.retryReason
          : ""

        logRagEvent("agent_step", "Hybrid evaluation complete", {
          service: "EvaluatorNode",
          similarity: blended.overallScore,
          durationMs: Date.now() - start,
        })

        this.recordMetrics(blended)
        return blended
        // eslint-disable-next-line no-unused-vars
      } catch (error: unknown) {
        // LLM evaluation failed — fall back to heuristic
        logRagEvent("agent_step", "LLM evaluation failed, using heuristic", {
          service: "EvaluatorNode",
        })

        this.recordMetrics(heuristicResult)
        return { ...heuristicResult, evaluationMethod: "heuristic" }
      }
    }

    // No API key — return heuristic result
    this.recordMetrics(heuristicResult)
    return { ...heuristicResult, evaluationMethod: "heuristic" }
  }

  // ── evaluateHeuristic ─────────────────────────────────────────────────
  // Fast rule-based evaluation. No LLM calls.
  // Catches obvious failures and clear successes immediately.
  private evaluateHeuristic(context: EvaluationContext): EvaluationResult {
    const { userQuery, toolCallHistory, draftAnswer } = context

    // ── Context Relevance: did we find anything useful? ────────────────
    let contextRelevance = 0.5 // baseline: assume moderate relevance

    const ragCalls = toolCallHistory.filter(tc => tc.toolName === "rag_search" && tc.success)
    const calcCalls = toolCallHistory.filter(tc => tc.toolName === "calculator" && tc.success)

    if (toolCallHistory.length === 0) {
      // No tools called — agent went straight to DONE
      contextRelevance = 0.1
    } else if (ragCalls.length > 0) {
      // Check if the RAG outputs mention relevant content
      const allOutputs = ragCalls.map(tc => tc.output.toLowerCase()).join(" ")
      const noResults =
        allOutputs.includes("no relevant chunks found") || allOutputs.includes("no results")

      if (noResults && ragCalls.length === 1) {
        contextRelevance = 0.1 // only searched once and found nothing
      } else if (noResults && ragCalls.length > 1) {
        contextRelevance = 0.2 // tried multiple times but still nothing
      } else {
        // Results were found — score by number of successful searches
        contextRelevance = Math.min(0.5 + ragCalls.length * 0.15, 0.9)
      }
    }

    // Calculator success boosts context relevance slightly
    if (calcCalls.length > 0) {
      contextRelevance = Math.min(contextRelevance + 0.1, 1.0)
    }

    // ── Faithfulness: is the draft answer grounded in the evidence? ────
    let faithfulness = 0.5

    const lowerDraft = draftAnswer.toLowerCase()

    // Strong signals of unfaithful answers
    const hallucination_signals = [
      "i believe",
      "i think",
      "probably",
      "likely",
      "it is possible",
      "might be",
      "could be",
      "generally speaking",
      "in general",
      "typically",
      "based on my knowledge",
      "from my training",
    ]

    const grounding_signals = [
      "[result",
      "[evidence",
      "[source",
      "according to",
      "the document",
      "the text",
      "states that",
      "mentions",
      "indicates",
      "shows that",
    ]

    const hallucinationCount = hallucination_signals.filter(s => lowerDraft.includes(s)).length
    const groundingCount = grounding_signals.filter(s => lowerDraft.includes(s)).length

    if (draftAnswer.trim() === "") {
      faithfulness = 0.0
    } else if (
      lowerDraft.includes("don't have enough information") ||
      lowerDraft.includes("cannot find") ||
      lowerDraft.includes("not in the provided")
    ) {
      // Agent correctly identified it doesn't have enough info
      faithfulness = 0.6 // honest but incomplete
    } else if (hallucinationCount > 2) {
      faithfulness = 0.2
    } else if (groundingCount > 0) {
      faithfulness = Math.min(0.6 + groundingCount * 0.1, 0.95)
    } else if (toolCallHistory.length > 0) {
      // Has evidence but doesn't explicitly reference it — moderate faithfulness
      faithfulness = 0.55
    }

    // ── Answer Relevance: does the answer address the query? ───────────
    let answerRelevance = 0.5

    if (draftAnswer.trim() === "") {
      answerRelevance = 0.0
    } else if (lowerDraft.includes("don't have enough") || lowerDraft.includes("cannot answer")) {
      answerRelevance = 0.4 // addressed the query honestly
    } else {
      // Check keyword overlap between query and answer
      const queryWords = userQuery
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 3)
      const answerWords = new Set(lowerDraft.split(/\s+/))
      const overlap = queryWords.filter(w => answerWords.has(w)).length
      const ratio = queryWords.length > 0 ? overlap / queryWords.length : 0

      answerRelevance = Math.min(0.4 + ratio * 0.6, 1.0)

      // Bonus for longer, more complete answers
      if (draftAnswer.length > 200) answerRelevance = Math.min(answerRelevance + 0.1, 1.0)
      if (draftAnswer.length > 500) answerRelevance = Math.min(answerRelevance + 0.1, 1.0)
    }

    // ── Compute overall score ─────────────────────────────────────────
    const overallScore = (contextRelevance + faithfulness + answerRelevance) / 3
    const shouldRetry = overallScore < QUALITY_THRESHOLD

    // ── Build retry reason ────────────────────────────────────────────
    let retryReason = ""
    if (shouldRetry) {
      if (contextRelevance < 0.4) {
        retryReason = "Search results were not relevant enough — try a different search query"
      } else if (faithfulness < 0.4) {
        retryReason = "Draft answer may not be well grounded in the retrieved evidence"
      } else if (answerRelevance < 0.4) {
        retryReason = "Draft answer does not fully address the user's question"
      } else {
        retryReason = "Overall quality is below threshold — more information may be needed"
      }
    }

    return {
      contextRelevance,
      faithfulness,
      answerRelevance,
      overallScore,
      shouldRetry,
      retryReason,
      evaluationMethod: "heuristic",
    }
  }

  // ── evaluateWithLLM ───────────────────────────────────────────────────
  // Asks Gemini to evaluate answer quality — more accurate than heuristics
  // but costs tokens. Only called for borderline scores.
  private async evaluateWithLLM(context: EvaluationContext): Promise<EvaluationResult> {
    const { userQuery, toolCallHistory, draftAnswer } = context

    // Build evidence summary for the evaluator
    const evidenceSummary = toolCallHistory
      .filter(tc => tc.success)
      .map(
        (tc, i) => `[Evidence ${i + 1}] Tool: ${tc.toolName}\nOutput: ${tc.output.slice(0, 300)}`
      )
      .join("\n\n")

    const evaluationPrompt = `You are a quality evaluator for an AI research assistant.

Evaluate the following answer on three dimensions. Be strict and precise.

USER QUERY:
${userQuery}

RETRIEVED EVIDENCE:
${evidenceSummary || "(No evidence retrieved)"}

DRAFT ANSWER:
${draftAnswer}

Rate each dimension from 0.0 to 1.0:

1. CONTEXT_RELEVANCE: Did the retrieved evidence actually contain information relevant to the query?
   - 0.0: Evidence completely unrelated
   - 0.5: Evidence partially relevant
   - 1.0: Evidence directly and fully relevant

2. FAITHFULNESS: Is the draft answer grounded ONLY in the retrieved evidence?
   - 0.0: Answer contains information not in the evidence (hallucination)
   - 0.5: Answer mostly grounded but has some unsupported claims
   - 1.0: Every claim in the answer traces directly to the evidence

3. ANSWER_RELEVANCE: Does the draft answer actually address what the user asked?
   - 0.0: Answer ignores the question entirely
   - 0.5: Answer partially addresses the question
   - 1.0: Answer completely and directly addresses the question

Also suggest a better search query if the answer should be retried.

Respond ONLY with valid JSON (no markdown fences):
{
  "contextRelevance": 0.0,
  "faithfulness": 0.0,
  "answerRelevance": 0.0,
  "shouldRetry": true,
  "retryReason": "specific reason why retry is needed",
  "suggestedQuery": "better search query to try next"
}`

    const requestBody: GeminiRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: evaluationPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1, // deterministic scoring
        topP: 1.0,
        maxOutputTokens: 256,
      },
    }

    if (!this.apiKey) throw new Error("No API key for LLM evaluation")

    const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      throw new Error(`Gemini evaluation API error: ${response.status}`)
    }

    const data = (await response.json()) as GeminiResponse
    const rawText = data.candidates[0]?.content.parts[0]?.text ?? ""

    return this.parseLLMEvaluation(rawText)
  }

  // ── parseLLMEvaluation ────────────────────────────────────────────────
  // Parses the LLM's JSON evaluation response.
  // Falls back to heuristic scores if parsing fails.
  private parseLLMEvaluation(rawText: string): EvaluationResult {
    const cleaned = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim()

    try {
      const parsed = JSON.parse(cleaned) as {
        contextRelevance?: unknown
        faithfulness?: unknown
        answerRelevance?: unknown
        shouldRetry?: unknown
        retryReason?: unknown
        suggestedQuery?: unknown
      }

      const contextRelevance = this.clamp(Number(parsed.contextRelevance ?? 0.5))
      const faithfulness = this.clamp(Number(parsed.faithfulness ?? 0.5))
      const answerRelevance = this.clamp(Number(parsed.answerRelevance ?? 0.5))
      const overallScore = (contextRelevance + faithfulness + answerRelevance) / 3

      return {
        contextRelevance,
        faithfulness,
        answerRelevance,
        overallScore,
        shouldRetry: overallScore < QUALITY_THRESHOLD,
        retryReason: typeof parsed.retryReason === "string" ? parsed.retryReason : "",
        suggestedQuery:
          typeof parsed.suggestedQuery === "string" ? parsed.suggestedQuery : undefined,
        evaluationMethod: "llm",
      }
    } catch {
      // Parsing failed — return neutral scores
      return {
        contextRelevance: 0.5,
        faithfulness: 0.5,
        answerRelevance: 0.5,
        overallScore: 0.5,
        shouldRetry: true,
        retryReason: "Could not parse evaluation response",
        evaluationMethod: "llm",
      }
    }
  }

  // ── recordMetrics ─────────────────────────────────────────────────────
  // Records RAG Triad scores in Prometheus for monitoring dashboards.
  private recordMetrics(result: EvaluationResult): void {
    ragTriadScores.labels("context_relevance").observe(result.contextRelevance)
    ragTriadScores.labels("faithfulness").observe(result.faithfulness)
    ragTriadScores.labels("answer_relevance").observe(result.answerRelevance)
  }

  // ── clamp ─────────────────────────────────────────────────────────────
  // Ensures a score stays within [0, 1].
  private clamp(value: number): number {
    return Math.max(0, Math.min(1, isNaN(value) ? 0.5 : value))
  }
}
