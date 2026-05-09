// frontend/src/components/MessageCard.tsx
// Updated Day 14: now renders AgentSteps below agent answers.

import CitationCard  from "./CitationCard"
import AgentSteps    from "./AgentSteps"
import type { ChatMessage } from "../types"

interface Props {
  message: ChatMessage
}

function formatAnswerWithCitations(text: string): React.ReactNode[] {
  const parts = text.split(/(\[(?:Source|Evidence) \d+\])/g)

  return parts.map((part, index) => {
    if (/^\[(?:Source|Evidence) \d+\]$/.test(part)) {
      return (
        <span
          key={index}
          className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 mx-0.5 cursor-default"
          title="Source citation — expand below to verify"
        >
          {part}
        </span>
      )
    }
    return <span key={index}>{part}</span>
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export default function MessageCard({ message }: Props) {
  const isUser  = message.sender === "user"
  const isAgent = message.sender === "agent"

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div className={`max-w-[88%] ${isUser ? "max-w-[70%]" : ""}`}>

        {/* ── Sender label ── */}
        <div className={`text-xs text-slate-400 mb-1 ${isUser ? "text-right" : "text-left"}`}>
          {isUser ? "You" : "🤖 ResearchBot"}
          <span className="ml-2 font-mono">{message.timestamp}</span>
        </div>

        {/* ── Message bubble ── */}
        <div
          className={`
            rounded-2xl px-4 py-3 shadow-sm
            ${isUser
              ? "bg-blue-600 text-white rounded-br-sm"
              : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm"
            }
          `}
        >
          {/* Answer text */}
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {isAgent
              ? formatAnswerWithCitations(message.text)
              : message.text
            }
          </p>

          {/* ── Agent Steps (agent messages only) ── */}
          {isAgent && message.agentSteps && message.agentSteps.length > 0 && (
            <AgentSteps
              steps={message.agentSteps}
              iterationCount={message.metadata?.iterationCount ?? message.agentSteps.length}
              totalDurationMs={message.metadata?.durationMs ?? 0}
            />
          )}

          {/* ── Citations (agent messages only) ── */}
          {isAgent && message.citations && message.citations.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-slate-400 font-medium mb-1.5 uppercase tracking-wide">
                Sources ({message.citations.length})
              </p>
              <div className="space-y-1">
                {message.citations.map((citation, index) => (
                  <CitationCard
                    key={citation.chunkId}
                    citation={citation}
                    index={index + 1}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Metadata footer ── */}
          {isAgent && message.metadata && (
            <div className="flex flex-wrap gap-3 pt-2 mt-3 text-xs border-t border-slate-100 text-slate-400">
              {message.metadata.iterationCount !== undefined && (
                <span>🤖 {message.metadata.iterationCount} iterations</span>
              )}
              {message.metadata.chunksRetrieved > 0 && (
                <span>📦 {message.metadata.chunksRetrieved} chunks</span>
              )}
              <span>🔤 {message.metadata.tokensUsed} tokens</span>
              <span>⏱ {formatDuration(message.metadata.durationMs)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}