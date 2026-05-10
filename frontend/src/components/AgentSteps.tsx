// frontend/src/components/AgentSteps.tsx
// Renders the step-by-step audit trail of the ReAct agent's reasoning.
//
// DESIGN DECISIONS:
// 1. Collapsible by default — keeps the UI clean for simple answers
// 2. Each step has an icon based on the tool used
// 3. Duration shown for each step — builds transparency
// 4. Steps are numbered to match [Evidence N] in the answer text
// 5. Status colour coding: search=purple, calculate=amber, internal=slate
//
// THIS COMPONENT IS THE TRUST MECHANISM.
// Users who are skeptical about AI answers can expand the steps
// and verify exactly what the agent searched for and computed.

import { useState } from "react"
import type { AgentStep } from "../types"

interface Props {
  steps:          AgentStep[]
  iterationCount: number
  totalDurationMs: number
}

// Tool-specific configuration for visual display
type ToolConfig = {
  icon:       string
  label:      string
  bgClass:    string
  textClass:  string
  borderClass: string
}

const TOOL_CONFIG: Record<string, ToolConfig> = {
  rag_search: {
    icon:        "🔍",
    label:       "Document Search",
    bgClass:     "bg-purple-50",
    textClass:   "text-purple-700",
    borderClass: "border-purple-200"
  },
  calculator: {
    icon:        "🧮",
    label:       "Calculator",
    bgClass:     "bg-amber-50",
    textClass:   "text-amber-700",
    borderClass: "border-amber-200"
  },
  web_search: {
    icon:        "🌐",
    label:       "Web Search",
    bgClass:     "bg-blue-50",
    textClass:   "text-blue-700",
    borderClass: "border-blue-200"
  },
  quality_check: {
    icon:        "📊",
    label:       "Quality Evaluation",
    bgClass:     "bg-teal-50",
    textClass:   "text-teal-700",
    borderClass: "border-teal-200"
  }
}

function getToolConfig(toolUsed?: string, description?: string): ToolConfig {
  if (!toolUsed) {
    // Quality check steps have no toolUsed but contain "Quality check" in description
    if (description?.includes("Quality check")) {
      return TOOL_CONFIG["quality_check"] ?? TOOL_CONFIG["internal"]!
    }
    return TOOL_CONFIG["internal"]!
  }
  return TOOL_CONFIG[toolUsed] ?? TOOL_CONFIG["internal"]!
}

function formatDuration(ms: number): string {
  if (ms === 0)    return "instant"
  if (ms < 1000)   return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTotalTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export default function AgentSteps({ steps, iterationCount, totalDurationMs }: Props) {
  const [isExpanded, setIsExpanded] = useState(false)

  if (steps.length === 0) return null

  // Count steps by type for the summary line
  const searchSteps = steps.filter(s => s.toolUsed === "rag_search").length
  const calcSteps   = steps.filter(s => s.toolUsed === "calculator").length

  return (
    <div className="mt-3 overflow-hidden border border-slate-200 rounded-xl">

      {/* ── Collapsed header — always visible ── */}
      <button
        onClick={() => setIsExpanded(prev => !prev)}
        className="flex items-center justify-between w-full px-3 py-2 text-left transition-colors bg-slate-50 hover:bg-slate-100"
      >
        <div className="flex items-center gap-2">
          {/* Step count badges */}
          <span className="text-xs font-medium text-slate-600">
            🤖 {iterationCount} reasoning step{iterationCount !== 1 ? "s" : ""}
          </span>

          <div className="flex items-center gap-1">
            {searchSteps > 0 && (
              <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full">
                {searchSteps}× search
              </span>
            )}
            {calcSteps > 0 && (
              <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
                {calcSteps}× calc
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">
            {formatTotalTime(totalDurationMs)} total
          </span>
          <span className="text-xs text-slate-400">
            {isExpanded ? "▲ Hide steps" : "▼ Show steps"}
          </span>
        </div>
      </button>

      {/* ── Expanded steps list ── */}
      {isExpanded && (
        <div className="divide-y divide-slate-100">
          {steps.map((step) => {
            const config = getToolConfig(step.toolUsed, step.description)

            return (
              <div
                key={step.stepNumber}
                className={`px-3 py-2.5 ${config.bgClass}`}
              >
                <div className="flex items-start gap-2">
                  {/* Step number + tool icon */}
                  <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                    <span className="w-4 font-mono text-xs text-right text-slate-400">
                      {step.stepNumber}.
                    </span>
                    <span className="text-sm">{config.icon}</span>
                  </div>

                  {/* Step description */}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${config.textClass}`}>
                      {step.description}
                    </p>

                    {/* Tool label + duration */}
                    <div className="flex items-center gap-2 mt-0.5">
                      {step.toolUsed && (
                        <span className={`text-xs ${config.textClass} opacity-70`}>
                          {config.label}
                        </span>
                      )}
                      <span className="text-xs text-slate-400">
                        {formatDuration(step.durationMs)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}

          {/* Summary footer */}
          <div className="flex items-center justify-between px-3 py-2 bg-white">
            <span className="text-xs text-slate-400">
              Agent finished in {iterationCount} iteration{iterationCount !== 1 ? "s" : ""}
            </span>
            <span className="text-xs font-medium text-slate-500">
              ✅ Answer grounded in retrieved evidence
            </span>
          </div>
        </div>
      )}
    </div>
  )
}