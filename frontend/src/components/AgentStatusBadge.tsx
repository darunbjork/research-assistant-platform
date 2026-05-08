// frontend/src/components/AgentStatusBadge.tsx
// Shows the current state of the ResearchBot agent.
// Displayed at the top of the chat window.
//
// States and their meaning:
//   idle       → ResearchBot is ready for a question
//   thinking   → Processing the query, deciding what to do
//   searching  → Running hybrid search against pgvector
//   generating → Calling Gemini to produce the answer
//   done       → Answer returned successfully
//   error      → Something went wrong

import type { AgentStatus } from "../types"

interface Props {
  status: AgentStatus
}

// Configuration for each status — label and colour
const STATUS_CONFIG: Record<AgentStatus, {
  label:     string
  dotClass:  string
  textClass: string
  bgClass:   string
}> = {
  idle: {
    label:     "ResearchBot ready",
    dotClass:  "bg-green-400",
    textClass: "text-green-700",
    bgClass:   "bg-green-50 border-green-200"
  },
  thinking: {
    label:     "Thinking...",
    dotClass:  "bg-blue-400 animate-pulse",
    textClass: "text-blue-700",
    bgClass:   "bg-blue-50 border-blue-200"
  },
  searching: {
    label:     "Searching documents...",
    dotClass:  "bg-purple-400 animate-pulse",
    textClass: "text-purple-700",
    bgClass:   "bg-purple-50 border-purple-200"
  },
  generating: {
    label:     "Generating answer...",
    dotClass:  "bg-orange-400 animate-pulse",
    textClass: "text-orange-700",
    bgClass:   "bg-orange-50 border-orange-200"
  },
  done: {
    label:     "Answer ready",
    dotClass:  "bg-green-400",
    textClass: "text-green-700",
    bgClass:   "bg-green-50 border-green-200"
  },
  error: {
    label:     "Something went wrong",
    dotClass:  "bg-red-400",
    textClass: "text-red-700",
    bgClass:   "bg-red-50 border-red-200"
  }
}

export default function AgentStatusBadge({ status }: Props) {
  const config = STATUS_CONFIG[status]

  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-medium ${config.bgClass}`}>
      {/* Animated dot indicates activity */}
      <span className={`w-2 h-2 rounded-full ${config.dotClass}`} />
      <span className={config.textClass}>{config.label}</span>
    </div>
  )
}
