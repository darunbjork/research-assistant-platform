// frontend/src/components/MessageCard.tsx
// Renders one chat message — either from the user or from ResearchBot.
//
// USER MESSAGES: simple right-aligned blue bubble
// AGENT MESSAGES: left-aligned white bubble with:
//   - The answer text (may contain [Source N] references)
//   - CitationCard for each source (expandable)
//   - Metadata footer (tokens, duration, chunks)

import CitationCard from "./CitationCard"
import type { ChatMessage } from "../types"

interface Props {
  message: ChatMessage
}

// Formats [Source N] references in the answer text as styled badges.
// "Revenue was $4.2M [Source 1]." →
// "Revenue was $4.2M " + <badge>[Source 1]</badge> + "."
function formatAnswerWithCitations(text: string): React.ReactNode[] {
  const parts = text.split(/(\[Source \d+\])/g)

  return parts.map((part, index) => {
    if (/^\[Source \d+\]$/.test(part)) {
      return (
        <span
          key={index}
          className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 mx-0.5"
        >
          {part}
        </span>
      )
    }
    return <span key={index}>{part}</span>
  })
}

// Formats milliseconds into a human-readable string
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export default function MessageCard({ message }: Props) {
  const isUser  = message.sender === "user"
  const isAgent = message.sender === "agent"

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div className={`max-w-[85%] ${isUser ? "max-w-[70%]" : ""}`}>

        {/* ── Sender label ── */}
        <div className={`text-xs text-slate-400 mb-1 ${isUser ? "text-right" : "text-left"}`}>
          {isUser ? "You" : "🤖 ResearchBot"}
          <span className="ml-2">{message.timestamp}</span>
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
          {/* Message text — with citation badge formatting for agent messages */}
          <p className="leading-relaxed whitespace-pre-wrap">
            {isAgent
              ? formatAnswerWithCitations(message.text)
              : message.text
            }
          </p>

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

          {/* ── Metadata footer (agent messages only) ── */}
          {isAgent && message.metadata && (
            <div className="mt-3 pt-2 border-t border-slate-100 flex flex-wrap gap-3 text-xs text-slate-400">
              <span>📦 {message.metadata.chunksRetrieved} chunks</span>
              <span>🔤 {message.metadata.tokensUsed} tokens</span>
              <span>⏱ {formatDuration(message.metadata.durationMs)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
