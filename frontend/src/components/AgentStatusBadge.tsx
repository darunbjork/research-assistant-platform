// frontend/src/components/AgentStatusBadge.tsx
// Updated Day 14: handles all agent-specific statuses from the ReAct loop.

import type { AgentStatus } from "../types"

interface Props {
  status: AgentStatus
}

type StatusConfig = {
  label:     string
  dotClass:  string
  textClass: string
  bgClass:   string
  icon:      string
}

const STATUS_CONFIG: Record<AgentStatus, StatusConfig> = {
  idle: {
    label: "ResearchBot ready",
    icon: "🟢",
    dotClass: "bg-green-400",
    textClass: "text-green-700",
    bgClass: "bg-green-50 border-green-200"
  },
  thinking: {
    label: "Reasoning...",
    icon: "💭",
    dotClass: "bg-blue-400 animate-pulse",
    textClass: "text-blue-700",
    bgClass: "bg-blue-50 border-blue-200"
  },
  searching: {
    label: "Searching documents...",
    icon: "🔍",
    dotClass: "bg-purple-400 animate-pulse",
    textClass: "text-purple-700",
    bgClass: "bg-purple-50 border-purple-200"
  },
  web_searching: {
    label: "Web searching...",
    icon: "🌐",
    dotClass: "bg-cyan-400 animate-pulse",
    textClass: "text-cyan-700",
    bgClass: "bg-cyan-50 border-cyan-200"
  },
  generating: {
    label: "Writing answer...",
    icon: "✍️",
    dotClass: "bg-orange-400 animate-pulse",
    textClass: "text-orange-700",
    bgClass: "bg-orange-50 border-orange-200"
  },
  evaluating: {
    label: "Checking quality...",
    icon: "🔎",
    dotClass: "bg-teal-400 animate-pulse",
    textClass: "text-teal-700",
    bgClass: "bg-teal-50 border-teal-200"
  },
  done: {
    label: "Answer ready",
    icon: "✅",
    dotClass: "bg-green-400",
    textClass: "text-green-700",
    bgClass: "bg-green-50 border-green-200"
  },
  error: {
    label: "Something went wrong",
    icon: "❌",
    dotClass: "bg-red-400",
    textClass: "text-red-700",
    bgClass: "bg-red-50 border-red-200"
  },
  calculating: {
    label: "",
    dotClass: "",
    textClass: "",
    bgClass: "",
    icon: ""
  }
}

export default function AgentStatusBadge({ status }: Props) {
  const config = STATUS_CONFIG[status]

  return (
    <div
      className={`
        inline-flex items-center gap-2 px-3 py-1.5
        rounded-full border text-sm font-medium
        transition-all duration-300
        ${config.bgClass}
      `}
    >
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${config.dotClass}`} />
      <span className="mr-0.5">{config.icon}</span>
      <span className={config.textClass}>{config.label}</span>
    </div>
  )
}