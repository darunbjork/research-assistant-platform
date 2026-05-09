// frontend/src/components/AgentComparison.tsx
// A development/demo component that sends the same query to both
// the simple RAG endpoint and the full Agent endpoint,
// and displays the results side by side.
//
// USE THIS TO:
// - Show stakeholders/interviewers the difference between RAG and Agent
// - Debug: when Agent gives wrong answers, compare with RAG baseline
// - Portfolio demo: shows your system's sophistication
//
// NOT shown in the main app — access at /demo route

import { useState } from "react"
import { queryRag, queryAgent } from "../utils/api"
import type { RagResult, AgentResult } from "../types"

export default function AgentComparison() {
  const [query,      setQuery]      = useState("")
  const [isRunning,  setIsRunning]  = useState(false)
  const [ragResult,  setRagResult]  = useState<RagResult | null>(null)
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null)
  const [ragError,   setRagError]   = useState<string | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)

  const runComparison = async (): Promise<void> => {
    if (!query.trim() || isRunning) return

    setIsRunning(true)
    setRagResult(null)
    setAgentResult(null)
    setRagError(null)
    setAgentError(null)

    // Run both in parallel
    const [ragPromise, agentPromise] = await Promise.allSettled([
      queryRag(query.trim()),
      queryAgent(query.trim())
    ])

    if (ragPromise.status === "fulfilled") {
      setRagResult(ragPromise.value)
    } else {
      setRagError(ragPromise.reason instanceof Error
        ? ragPromise.reason.message
        : "RAG query failed"
      )
    }

    if (agentPromise.status === "fulfilled") {
      setAgentResult(agentPromise.value)
    } else {
      setAgentError(agentPromise.reason instanceof Error
        ? agentPromise.reason.message
        : "Agent query failed"
      )
    }

    setIsRunning(false)
  }

  return (
    <div className="max-w-6xl p-6 mx-auto">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-slate-800">
          ⚡ RAG vs 🤖 Agent — Side-by-Side Comparison
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Same query, two approaches. See when each excels.
        </p>
      </div>

      {/* Query input */}
      <div className="flex gap-3 mb-8">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void runComparison() }}
          placeholder="Enter a query to compare both approaches..."
          className="flex-1 px-4 py-3 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={() => void runComparison()}
          disabled={isRunning || !query.trim()}
          className="flex items-center gap-2 px-6 py-3 text-sm font-medium text-white transition-colors bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-xl"
        >
          {isRunning ? (
            <>
              <span className="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin" />
              Running...
            </>
          ) : "Compare"}
        </button>
      </div>

      {/* Results */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">

        {/* RAG result */}
        <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-lg">⚡</span>
            <h2 className="font-semibold text-slate-800">Simple RAG</h2>
            <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
              /api/v1/rag/query
            </span>
          </div>

          {isRunning && (
            <div className="space-y-2 animate-pulse">
              <div className="h-4 rounded bg-slate-100" />
              <div className="w-3/4 h-4 rounded bg-slate-100" />
            </div>
          )}

          {ragError && (
            <p className="text-sm text-red-600">{ragError}</p>
          )}

          {ragResult && (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-slate-700">
                {ragResult.answer}
              </p>
              <div className="flex gap-3 text-xs text-slate-400">
                <span>📦 {ragResult.chunksRetrieved} chunks</span>
                <span>⏱ {ragResult.durationMs}ms</span>
                <span>🔤 {ragResult.tokensUsed} tokens</span>
              </div>
            </div>
          )}
        </div>

        {/* Agent result */}
        <div className="p-5 bg-white border border-blue-200 shadow-sm rounded-xl">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-lg">🤖</span>
            <h2 className="font-semibold text-slate-800">ReAct Agent</h2>
            <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
              /api/v1/agent/chat
            </span>
          </div>

          {isRunning && (
            <div className="space-y-2 animate-pulse">
              <div className="h-4 rounded bg-slate-100" />
              <div className="w-3/4 h-4 rounded bg-slate-100" />
            </div>
          )}

          {agentError && (
            <p className="text-sm text-red-600">{agentError}</p>
          )}

          {agentResult && (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-slate-700">
                {agentResult.finalAnswer}
              </p>

              {agentResult.steps.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1.5 uppercase tracking-wide">
                    Reasoning steps:
                  </p>
                  <div className="space-y-1">
                    {agentResult.steps.map(step => (
                      <div key={step.stepNumber} className="flex gap-2 text-xs text-slate-500">
                        <span className="font-mono text-slate-400">{step.stepNumber}.</span>
                        <span>
                          {step.toolUsed === "rag_search" && "🔍 "}
                          {step.toolUsed === "calculator" && "🧮 "}
                          {step.description}
                          <span className="ml-1 text-slate-400">({step.durationMs}ms)</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3 text-xs text-slate-400">
                <span>🔄 {agentResult.iterationCount} iterations</span>
                <span>⏱ {agentResult.durationMs}ms</span>
                <span>🔤 {agentResult.tokensUsed} tokens</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}