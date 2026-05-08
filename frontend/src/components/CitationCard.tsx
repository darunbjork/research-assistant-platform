// frontend/src/components/CitationCard.tsx
// Displays one source citation below an agent answer.
// Shows: document name, relevance score, page number (if available),
// and the excerpt from the chunk — the proof the answer is grounded.
//
// EXPANDABLE DESIGN:
// By default shows a compact summary (document name + score).
// Clicking "Show excerpt" expands to show the actual chunk text.
// This keeps the UI clean for short answers and detailed for verification.

import { useState } from "react"
import type { Citation } from "../types"

interface Props {
  citation: Citation
  index:    number   // 1-based source number ([Source 1], [Source 2], etc.)
}

// Formats a relevance score (0-1) as a percentage
function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`
}

// Formats a file size or source name for display
function formatSourceName(name: string): string {
  // Truncate long file names
  if (name.length > 40) {
    return `...${name.slice(-37)}`
  }
  return name
}

export default function CitationCard({ citation, index }: Props) {
  const [expanded, setExpanded] = useState(false)

  const relevancePercentage = formatScore(citation.relevanceScore)

  return (
    <div className="mt-1 border border-slate-200 rounded-lg bg-slate-50 text-sm overflow-hidden">
      {/* ── Header — always visible ── */}
      <div className="flex items-center justify-between px-3 py-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Source number badge */}
          <span className="shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center">
            {index}
          </span>

          {/* Document icon + name */}
          <span className="text-slate-600 truncate font-medium">
            📄 {formatSourceName(citation.documentName)}
          </span>

          {/* Page number badge if available */}
          {citation.pageNumber !== undefined && (
            <span className="shrink-0 text-xs text-slate-400 bg-slate-200 px-1.5 py-0.5 rounded">
              p.{citation.pageNumber}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Relevance score */}
          <span className="text-xs text-slate-500">
            {relevancePercentage} match
          </span>

          {/* Expand/collapse toggle */}
          <button
            onClick={() => setExpanded(prev => !prev)}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
          >
            {expanded ? "Hide ▲" : "Show ▼"}
          </button>
        </div>
      </div>

      {/* ── Expanded excerpt — the actual chunk text ── */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-slate-200">
          <p className="text-slate-600 leading-relaxed italic text-xs">
            "{citation.excerpt}"
          </p>
          <div className="mt-2 flex items-center gap-1 text-xs text-slate-400">
            <span>Relevance score:</span>
            <span className="font-mono">{citation.relevanceScore.toFixed(5)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
