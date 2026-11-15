import type { ToolDecision } from "../../types/agent.types"
import { logRagEvent } from "../../utils/logger"

export function parseToolDecision(rawText: string): ToolDecision {
  const cleaned = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim()

  try {
    const parsed = JSON.parse(cleaned) as {
      toolName?: unknown
      input?: unknown
      reason?: unknown
    }

    if (typeof parsed.toolName !== "string") {
      throw new Error("toolName must be a string")
    }

    return {
      toolName: parsed.toolName,
      input:
        typeof parsed.input === "object" && parsed.input !== null
          ? (parsed.input as Record<string, string>)
          : {},
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    }
  } catch {
    // V8: message must reflect throw (not "defaulting to DONE")
    logRagEvent("agent_step", "Failed to parse tool decision", {
      service: "AgentEngine",
    })
    throw new Error("Gemini returned an invalid tool decision. Please try again.")
  }
}
