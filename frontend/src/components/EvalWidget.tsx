// frontend/src/components/EvalWidget.tsx
// A developer tool component for evaluating RAG pipeline quality.
// Not shown in the main chat UI — accessed at /eval route.
// Used during development to measure quality after making changes.

import { useState } from "react"
import api          from "../utils/api"
import type { ApiResult } from "../types"

interface EvalResult {
  evalId:  string
  scores: {
    contextRelevance: number
    faithfulness:     number
    answerRelevance:  number
    overallScore:     number
  }
  feedback: {
    contextRelevance:  string
    faithfulness:      string
    answerRelevance:   string
    overallAssessment: string
  }
  recommendations: string[]
  durationMs:      number,
  model:           string
}

function ScoreBar({ score, label }: { score: number; label: string }) {
  const pct   = Math.round(score * 100)
  const color = score >= 0.85 ? "bg-green-500"
              : score >= 0.70 ? "bg-yellow-500"
              : "bg-red-500"

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <span className={`text-sm font-bold ${
          score >= 0.85 ? "text-green-600" :
          score >= 0.70 ? "text-yellow-600" : "text-red-600"
        }`}>{pct}%</span>
      </div>
      <div className="w-full h-2 rounded-full bg-slate-200">
        <div
          className={`h-2 rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export default function EvalWidget() {
  const [query,    setQuery]    = useState("")
  const [context,  setContext]  = useState("")
  const [answer,   setAnswer]   = useState("")
  const [result,   setResult]   = useState<EvalResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const handleEvaluate = async (): Promise<void> => {
    if (!query.trim() || !context.trim() || !answer.trim()) {
      setError("Please fill in all three fields.")
      return
    }

    setIsLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await api.post<ApiResult<EvalResult>>(
        "/api/v1/eval/score",
        {
          query:            query.trim(),
          retrievedContext: context.split("\n\n").filter(c => c.trim()),
          answer:           answer.trim()
        }
      )

      if (!response.data.success || !response.data.data) {
        throw new Error(response.data.error ?? "Evaluation failed")
      }

      setResult(response.data.data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Evaluation failed")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="max-w-4xl p-6 mx-auto">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-slate-800">
          📐 RAG Triad Evaluator
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Measure your pipeline quality: Context Relevance · Faithfulness · Answer Relevance
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 mb-6 md:grid-cols-2">
        {/* Input panel */}
        <div className="space-y-4">
          <div>
            <label className="block mb-1 text-sm font-medium text-slate-700">
              1. User Query
            </label>
            <textarea
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="What is machine learning?"
              rows={2}
              className="w-full px-3 py-2 text-sm border rounded-lg border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block mb-1 text-sm font-medium text-slate-700">
              2. Retrieved Context
              <span className="ml-1 font-normal text-slate-400">
                (separate chunks with a blank line)
              </span>
            </label>
            <textarea
              value={context}
              onChange={e => setContext(e.target.value)}
              placeholder={"Chunk 1: Machine learning is a subset of AI...\n\nChunk 2: It enables systems to learn from data..."}
              rows={5}
              className="w-full px-3 py-2 font-mono text-sm border rounded-lg border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block mb-1 text-sm font-medium text-slate-700">
              3. Generated Answer
            </label>
            <textarea
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              placeholder="Machine learning is a subset of AI [Source 1]..."
              rows={3}
              className="w-full px-3 py-2 text-sm border rounded-lg border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <div className="p-3 border border-red-200 rounded-lg bg-red-50">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <button
            onClick={() => void handleEvaluate()}
            disabled={isLoading}
            className="flex items-center justify-center w-full gap-2 py-3 text-sm font-semibold text-white transition-colors bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-xl"
          >
            {isLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin" />
                Evaluating with Gemini...
              </>
            ) : "Run RAG Triad Evaluation"}
          </button>
        </div>

        {/* Results panel */}
        <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
          {result === null ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="text-slate-400">
                <div className="mb-3 text-4xl">📐</div>
                <p className="text-sm">
                  Fill in the form and click evaluate.<br/>
                  Scores appear here.
                </p>
              </div>
            </div>
          ) : (
            <div>
              <h3 className="mb-4 font-semibold text-slate-800">
                Evaluation Results
              </h3>

              <ScoreBar score={result.scores.contextRelevance} label="Context Relevance" />
              <ScoreBar score={result.scores.faithfulness}     label="Faithfulness" />
              <ScoreBar score={result.scores.answerRelevance}  label="Answer Relevance" />

              <div className="pt-3 mt-4 border-t border-slate-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-slate-700">Overall Score</span>
                  <span className={`text-lg font-bold ${
                    result.scores.overallScore >= 0.85 ? "text-green-600" :
                    result.scores.overallScore >= 0.70 ? "text-yellow-600" :
                    "text-red-600"
                  }`}>
                    {Math.round(result.scores.overallScore * 100)}%
                  </span>
                </div>
              </div>

              <div className="p-3 mt-4 rounded-lg bg-slate-50">
                <p className="mb-1 text-xs font-medium text-slate-600">Assessment</p>
                <p className="text-sm text-slate-700">
                  {result.feedback.overallAssessment}
                </p>
              </div>

              {result.recommendations.length > 0 && (
                <div className="mt-3">
                  <p className="mb-2 text-xs font-medium tracking-wide uppercase text-slate-500">
                    Recommendations
                  </p>
                  <ul className="space-y-1.5">
                    {result.recommendations.map((rec, i) => (
                      <li key={i} className="flex gap-2 text-xs text-slate-600">
                        <span className="flex-shrink-0 text-blue-500">→</span>
                        <span>{rec.slice(0, 120)}{rec.length > 120 ? "..." : ""}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="mt-3 text-xs text-right text-slate-400">
                Evaluated in {result.durationMs}ms · {result.model}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}