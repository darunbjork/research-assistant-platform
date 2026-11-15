import type { AgentStatus, ToolDecision } from "../../types/agent.types"

export function describeStep(decision: ToolDecision): string {
  switch (decision.toolName) {
    case "rag_search":
      return `Searching documents: "${decision.input["query"] ?? ""}"`
    case "calculator":
      return `Calculating: ${decision.input["expression"] ?? ""}`
    case "web_search":
      return `Searching the web: "${decision.input["query"] ?? ""}"`
    default:
      return `Running: ${decision.toolName}`
  }
}

export function statusForTool(toolName: string): AgentStatus {
  if (toolName === "rag_search") return "searching"
  if (toolName === "calculator") return "calculating"
  return "searching"
}
