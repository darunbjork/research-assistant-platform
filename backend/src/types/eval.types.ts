// backend/src/types/eval.types.ts
// All types for the RAG Triad evaluation system.
//
// The RAG Triad was popularised by the TruLens framework (2023).
// It provides a structured way to measure RAG quality beyond
// simple "did the user like the answer?" feedback.
//
// WHY STORE EVALUATIONS?
// A single score is a data point.
// A hundred scores over time is a trend.
// With stored evaluations you can answer:
//   "Did upgrading the reranker improve faithfulness?"
//   "Does chunk size 256 have better context relevance than 512?"
//   "Which query types consistently score lowest?"

// ── Core RAG Triad Result ─────────────────────────────────────────────────

export interface RagTriadScore {
  // Context Relevance (0-1):
  // Did the retrieval pipeline find chunks relevant to the query?
  // Evaluator: reads the query + retrieved chunks together
  contextRelevance: number

  // Faithfulness (0-1):
  // Is every claim in the answer supported by the retrieved context?
  // Evaluator: reads the answer + retrieved chunks together
  faithfulness: number

  // Answer Relevance (0-1):
  // Does the answer actually address what the user asked?
  // Evaluator: reads the query + answer together
  answerRelevance: number

  // Weighted average of all three
  overallScore: number
}

// ── Evaluation Request ────────────────────────────────────────────────────
// What the evaluation endpoint receives

export interface EvalRequest {
  query: string // the user's question
  retrievedContext: string[] // the chunk contents that were retrieved
  answer: string // the generated answer
  // Optional metadata for filtering/grouping evaluations
  documentIds?: string[]
  pipelineVersion?: string // e.g. "v1-no-reranker" or "v2-with-reranker"
}

// ── Evaluation Result ─────────────────────────────────────────────────────
// What the evaluation endpoint returns

export interface EvalResult {
  evalId: string // unique identifier for this evaluation
  scores: RagTriadScore
  feedback: EvalFeedback // human-readable explanation of each score
  recommendations: string[] // suggested improvements
  evaluatedAt: string // ISO timestamp
  durationMs: number
  model: string // which LLM was used to evaluate
}

// ── Feedback ──────────────────────────────────────────────────────────────
// Human-readable explanation of each dimension's score

export interface EvalFeedback {
  contextRelevance: string // why this score was assigned
  faithfulness: string
  answerRelevance: string
  overallAssessment: string // one-sentence summary
}

// ── Batch Evaluation ──────────────────────────────────────────────────────
// For running evaluation across multiple query-answer pairs

export interface BatchEvalRequest {
  pairs: EvalRequest[]
  pipelineVersion?: string
}

export interface BatchEvalResult {
  results: EvalResult[]
  aggregateScores: RagTriadScore // average across all pairs
  worstDimension: keyof RagTriadScore
  bestDimension: keyof RagTriadScore
  totalDurationMs: number
}

// ── Eval History ──────────────────────────────────────────────────────────
// Stored in the database for trend tracking

export interface EvalHistoryEntry {
  id: string
  query: string
  contextRelevance: number
  faithfulness: number
  answerRelevance: number
  overallScore: number
  pipelineVersion: string
  createdAt: string
}

// ── Comparison Result ─────────────────────────────────────────────────────
// For A/B testing two pipeline versions

export interface PipelineComparison {
  versionA: string
  versionB: string
  scoresA: RagTriadScore
  scoresB: RagTriadScore
  winner: string // which version scored higher overall
  improvement: number // percentage improvement (positive = B is better)
}
