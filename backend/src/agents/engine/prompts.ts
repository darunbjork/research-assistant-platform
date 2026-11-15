import type { GeminiRequest } from "../../types/llm.types"
import type { AgentState, ToolCall } from "../../types/agent.types"
import type { EvaluationResult } from "../nodes/evaluate.node"
import type { ToolRegistry } from "../tools/index"
import { formatToolDescriptions } from "../tools/index"
import { CONTEXT_DATA_RULE, wrapInContext } from "../../utils/prompt-boundary"

export const REASONING_GENERATION_CONFIG: NonNullable<GeminiRequest["generationConfig"]> = {
  temperature: 0.1,
  topP: 1.0,
  maxOutputTokens: 4096,
  responseMimeType: "application/json",
}

export const DRAFT_GENERATION_CONFIG: NonNullable<GeminiRequest["generationConfig"]> = {
  temperature: 0.1,
  topP: 1.0,
  maxOutputTokens: 4096,
}

export const SYNTHESIS_GENERATION_CONFIG: NonNullable<GeminiRequest["generationConfig"]> = {
  temperature: 0.1,
  topP: 0.8,
  maxOutputTokens: 4096,
}

function historyText(state: AgentState): string {
  if (state.toolCallHistory.length === 0) {
    return "No tools called yet."
  }
  return state.toolCallHistory
    .map(
      (tc: ToolCall, i: number) =>
        `Step ${i + 1} — ${tc.toolName}\n` +
        `Input: ${JSON.stringify(tc.input)}\n` +
        `Output: ${tc.output}`
    )
    .join("\n\n")
}

export function buildReasoningPrompt(
  state: AgentState,
  tools: ToolRegistry,
  lastEval: EvaluationResult | null,
  maxIterations: number
): string {
  const toolDescriptions = formatToolDescriptions(tools)
  const evalFeedback =
    lastEval !== null
      ? `\nLAST EVALUATION: ${(lastEval.overallScore * 100).toFixed(0)}%\n` +
        `RETRY REASON: ${lastEval.retryReason}\n` +
        (lastEval.suggestedQuery ? `SUGGESTED QUERY: "${lastEval.suggestedQuery}"` : "")
      : ""

  return `You are a research assistant deciding the next action.

USER QUERY: ${state.userQuery}

AVAILABLE TOOLS:
${toolDescriptions}
- DONE: When you have enough high-quality information.

HISTORY (${state.iterationCount}/${maxIterations} steps):
${wrapInContext(historyText(state))}
${evalFeedback}
${CONTEXT_DATA_RULE}

RULES:
1. If evaluation score >= 70% and query is fully addressed: DONE.
2. If score < 70%: use rag_search with the SUGGESTED QUERY if provided.
3. Never repeat an identical search query.
4. After 4+ searches: DONE.

Respond ONLY with valid JSON:
{"toolName": "tool_name", "input": {"key": "value"}, "reason": "brief reason"}`
}

export function buildDraftPrompt(state: AgentState): string {
  const evidence = state.toolCallHistory
    .filter(tc => tc.success)
    .map((tc, i) => `[Evidence ${i + 1}] (${tc.toolName}): ${tc.output}`)
    .join("\n\n")

  return `Draft a concise answer using ONLY the evidence below.
QUERY: ${state.userQuery}
EVIDENCE:
${wrapInContext(evidence)}
${CONTEXT_DATA_RULE}
Draft (2-4 sentences):`
}

export function buildSynthesisPrompt(state: AgentState): string {
  const evidence = state.toolCallHistory
    .filter(tc => tc.success)
    .map(
      (tc, i) =>
        `[Evidence ${i + 1}] (${tc.toolName}, input: ${JSON.stringify(tc.input)})\n${tc.output}`
    )
    .join("\n\n---\n\n")

  return `Answer using ONLY the evidence below.
QUESTION: ${state.userQuery}
EVIDENCE:
${wrapInContext(evidence)}
${CONTEXT_DATA_RULE}
RULES:
1. Only use information from the evidence.
2. If insufficient: say "Based on the available documents, I could not find a complete answer."
3. Cite evidence as [Evidence N].
4. Be concise and factual.`
}
