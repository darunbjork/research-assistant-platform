import { geminiText } from "../utils/gemini-response"
// backend/src/services/streaming.agent.service.ts
// The streaming version of AgentService.
// Instead of returning a Promise<AgentResult>, it emits events
// through a callback as each stage of the ReAct loop completes.
//
// ARCHITECTURE DECISION:
// We do NOT modify AgentService to add streaming.
// Instead, we create a StreamingAgentService that:
//   1. Wraps the same logic as AgentService
//   2. Emits events at each stage via an onEvent callback
//   3. Returns the same AgentResult at the end
//
// WHY SEPARATE SERVICE?
// AgentService (Day 13/15) is clean, tested, and HTTP-focused.
// StreamingAgentService is WebSocket-focused.
// Keeping them separate means tests for AgentService still work
// without WebSocket infrastructure.
//
// THE ONVENT PATTERN:
// The service receives an onEvent function.
// Every time something notable happens, it calls onEvent(message).
// The WebSocket handler converts those calls into ws.send() calls.
// The StreamingAgentService has no knowledge of WebSocket — it just
// calls a callback. This makes it testable without a real WebSocket.

import type { HybridSearchService } from "./hybrid.search.service"
import type { GenerationService } from "./generation.service"
import type {
  AgentState,
  AgentResult,
  AgentStep,
  ToolCall,
  ToolDecision,
} from "../types/agent.types"
import type { GeminiRequest, GeminiResponse } from "../types/llm.types"
import type { Citation } from "../types/retrieval.types"
import type { ServerMessage } from "../types/websocket.types"
import { createToolRegistry, formatToolDescriptions } from "../agents/tools/index"
import { classifyQuery } from "../agents/nodes/classify.node"
import { EvaluatorNode } from "../agents/nodes/evaluate.node"
import type { EvaluationResult } from "../agents/nodes/evaluate.node"
import { logRagEvent, logError } from "../utils/logger"
import { agentIterations } from "../utils/metrics"
import { requestGemini } from "../utils/gemini-request"
import { RateLimitError } from "../middleware/error.middleware"
import { env } from "../config/env"
import { CONTEXT_DATA_RULE, wrapInContext } from "../utils/prompt-boundary"
import { parseToolDecision } from "../agents/engine/decision"
import { extractCitationsFromHistory } from "../agents/engine/citations"
import { describeStep, statusForTool } from "../agents/engine/steps"
import type { AgentEventCallback } from "../agents/engine/types"

// ── Constants ──────────────────────────────────────────────────────────────
const GEMINI_MODEL = env.GEMINI_GENERATION_MODEL
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const MAX_ITERATIONS = 5

export type { AgentEventCallback } from "../agents/engine/types"

// ── Token tracking ─────────────────────────────────────────────────────────
interface TokenUsage {
  total: number
}

export class StreamingAgentService {
  private readonly evaluator: EvaluatorNode

  constructor(
    private readonly apiKey: string,
    private readonly hybridSearchService: HybridSearchService,
    private readonly generationService: GenerationService
  ) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error("StreamingAgentService requires a Gemini API key")
    }
    this.evaluator = new EvaluatorNode(apiKey)
  }

  // ── run ───────────────────────────────────────────────────────────────
  // Runs the full ReAct + self-correction loop, emitting events via onEvent.
  async run(
    userQuery: string,
    userId: string,
    sessionId: string,
    onEvent: AgentEventCallback,
    signal?: AbortSignal
  ): Promise<AgentResult> {
    const startedAt = new Date()
    const steps: AgentStep[] = []
    const tokenUsage: TokenUsage = { total: 0 }
    let lastEval: EvaluationResult | null = null

    // ── Emit: session started ─────────────────────────────────────────
    this.emit(onEvent, {
      type: "status",
      status: "thinking",
      sessionId,
      message: "Analysing your question...",
    })

    logRagEvent("agent_step", "Streaming agent session started", {
      service: "StreamingAgentService",
      sessionId,
      userId,
    })

    const state: AgentState = {
      sessionId,
      userQuery,
      taskType: classifyQuery(userQuery),
      searchResults: [],
      toolCallHistory: [],
      draftAnswer: "",
      finalAnswer: "",
      citations: [],
      iterationCount: 0,
      isComplete: false,
      qualityScore: 0,
      status: "thinking",
      startedAt,
    }

    const toolRegistry = createToolRegistry(this.hybridSearchService, userId)

    try {
      // ── ReAct + Self-Correction Loop ───────────────────────────────────
      while (!state.isComplete && state.iterationCount < MAX_ITERATIONS) {
        if (signal?.aborted) {
          state.status = "aborted"
          break
        }
        state.iterationCount++
        state.status = "thinking"

        // ── REASON ────────────────────────────────────────────────────
        let decision: ToolDecision
        try {
          decision = await this.reasonNextAction(state, toolRegistry, tokenUsage, lastEval, signal)
        } catch (error: unknown) {
          if (signal?.aborted) {
            state.status = "aborted"
            break
          }
          logError("Streaming agent reasoning failed", error, {
            service: "StreamingAgentService",
            sessionId,
          })

          throw error
        }

        // ── CHECK: DONE ───────────────────────────────────────────────
        if (decision.toolName === "DONE") {
          const doneStep: AgentStep = {
            stepNumber: state.iterationCount,
            description: lastEval?.shouldRetry
              ? "Search completed; evidence may be incomplete"
              : "Determined sufficient information gathered",
            durationMs: 0,
            timestamp: new Date(),
          }
          steps.push(doneStep)

          this.emit(onEvent, { type: "step", sessionId, step: doneStep })

          state.isComplete = true
          break
        }

        // ── ACT: Execute tool ─────────────────────────────────────────
        const tool = toolRegistry[decision.toolName]

        if (tool === undefined) {
          logRagEvent("agent_step", `Unknown tool: ${decision.toolName}`, {
            service: "StreamingAgentService",
            sessionId,
          })
          continue
        }

        // Emit status for the tool that is about to run
        this.emit(onEvent, {
          type: "status",
          status: statusForTool(decision.toolName),
          sessionId,
          message: describeStep(decision),
        })

        const toolStart = Date.now()
        let toolOutput = ""
        let toolSuccess = true
        let toolError: string | undefined

        try {
          toolOutput = await tool.execute(decision.input)
        } catch (error: unknown) {
          toolSuccess = false
          toolError = error instanceof Error ? error.message : "Tool execution failed"
          toolOutput = `Tool error: ${toolError}`
          logError(`Tool ${decision.toolName} failed`, error, {
            service: "StreamingAgentService",
            sessionId,
          })
        }

        const toolDurationMs = Date.now() - toolStart

        // ── OBSERVE: Record the tool call ─────────────────────────────
        const toolCall: ToolCall = {
          toolName: decision.toolName,
          input: decision.input,
          output: toolOutput,
          durationMs: toolDurationMs,
          timestamp: new Date(),
          success: toolSuccess,
          error: toolError,
        }

        state.toolCallHistory.push(toolCall)
        agentIterations.inc({ tool: decision.toolName })

        const step: AgentStep = {
          stepNumber: state.iterationCount,
          description: describeStep(decision),
          toolUsed: decision.toolName,
          durationMs: toolDurationMs,
          timestamp: new Date(),
        }
        steps.push(step)

        // ── Emit: step completed ───────────────────────────────────────
        this.emit(onEvent, { type: "step", sessionId, step })

        // ── DRAFT + EVALUATE ──────────────────────────────────────────
        if (toolSuccess && state.toolCallHistory.length > 0) {
          state.status = "evaluating"

          this.emit(onEvent, {
            type: "status",
            status: "evaluating",
            sessionId,
            message: "Checking answer quality...",
          })

          state.draftAnswer = await this.draftAnswer(state, tokenUsage, signal)

          const evalStart = Date.now()
          lastEval = await this.evaluator.evaluate(
            {
              userQuery: state.userQuery,
              toolCallHistory: state.toolCallHistory,
              draftAnswer: state.draftAnswer,
              iterationCount: state.iterationCount,
              maxIterations: MAX_ITERATIONS,
            },
            signal
          )

          tokenUsage.total += lastEval.tokensUsed ?? 0

          state.qualityScore = lastEval.overallScore

          // ── Emit: quality check result ─────────────────────────────
          this.emit(onEvent, {
            type: "quality",
            sessionId,
            score: lastEval.overallScore,
            shouldRetry: lastEval.shouldRetry,
            retryReason: lastEval.retryReason,
            suggestedQuery: lastEval.suggestedQuery,
          })

          // Add evaluation step to the audit trail
          const evalStep: AgentStep = {
            stepNumber: state.iterationCount,
            description:
              `Quality check: ${(lastEval.overallScore * 100).toFixed(0)}% ` +
              (lastEval.shouldRetry ? `— retrying (${lastEval.retryReason})` : "— sufficient ✓"),
            durationMs: Date.now() - evalStart,
            timestamp: new Date(),
          }
          steps.push(evalStep)

          this.emit(onEvent, { type: "step", sessionId, step: evalStep })

          logRagEvent("agent_step", "Self-evaluation complete", {
            service: "StreamingAgentService",
            sessionId,
            similarity: lastEval.overallScore,
          })

          // ── Self-correction decision ───────────────────────────────
          if (!lastEval.shouldRetry) {
            state.isComplete = true
            break
          }

          // Quality below threshold — emit status and continue to next iteration
          this.emit(onEvent, {
            type: "status",
            status: "thinking",
            sessionId,
            message: "Quality below threshold — searching again...",
          })
        }
      }

      // ── SYNTHESISE: Generate the final answer ─────────────────────────
      // Aborted (client disconnect / WS close): emit a terminal status and
      // return without emitting "complete" — abort is not a failure.
      if (signal?.aborted) {
        state.status = "aborted"
        state.completedAt = new Date()
        const abortedResult: AgentResult = {
          sessionId,
          finalAnswer: state.finalAnswer,
          citations: state.citations,
          steps,
          iterationCount: state.iterationCount,
          status: "aborted",
          tokensUsed: tokenUsage.total,
          durationMs: Date.now() - startedAt.getTime(),
        }
        this.emit(onEvent, {
          type: "status",
          status: "aborted",
          sessionId,
          message: "Request cancelled",
        })
        logRagEvent("agent_step", "Streaming agent session aborted", {
          service: "StreamingAgentService",
          sessionId,
          iterationCount: state.iterationCount,
        })
        return abortedResult
      }

      state.status = "generating"

      this.emit(onEvent, {
        type: "status",
        status: "generating",
        sessionId,
        message: "Writing your answer...",
      })

      const { answer, citations } = await this.synthesiseFinalAnswer(state, tokenUsage, signal)

      state.finalAnswer = answer
      state.citations = citations
      state.status = "done"
      state.completedAt = new Date()

      const totalDurationMs = Date.now() - startedAt.getTime()

      const finalResult: AgentResult = {
        sessionId,
        finalAnswer: state.finalAnswer,
        citations: state.citations,
        steps,
        iterationCount: state.iterationCount,
        status: "done",
        tokensUsed: tokenUsage.total,
        durationMs: totalDurationMs,
      }

      // ── Emit: session complete ─────────────────────────────────────────
      this.emit(onEvent, {
        type: "complete",
        sessionId,
        result: finalResult,
      })

      logRagEvent("agent_step", "Streaming agent session complete", {
        service: "StreamingAgentService",
        sessionId,
        iterationCount: state.iterationCount,
        durationMs: totalDurationMs,
      })

      return finalResult
    } catch (error: unknown) {
      // Aborted mid-call: terminal "aborted" status, no "complete" event.
      if (signal?.aborted) {
        state.status = "aborted"
        state.completedAt = new Date()
        const abortedResult: AgentResult = {
          sessionId,
          finalAnswer: state.finalAnswer,
          citations: state.citations,
          steps,
          iterationCount: state.iterationCount,
          status: "aborted",
          tokensUsed: tokenUsage.total,
          durationMs: Date.now() - startedAt.getTime(),
        }
        this.emit(onEvent, {
          type: "status",
          status: "aborted",
          sessionId,
          message: "Request cancelled",
        })
        logRagEvent("agent_step", "Streaming agent session aborted", {
          service: "StreamingAgentService",
          sessionId,
          iterationCount: state.iterationCount,
        })
        return abortedResult
      }
      throw error
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  // Type-safe event emitter — never throws even if callback throws
  private emit(onEvent: AgentEventCallback, message: ServerMessage): void {
    try {
      onEvent(message)
    } catch (error: unknown) {
      logError("Event callback threw", error, {
        service: "StreamingAgentService",
      })
    }
  }

  private async reasonNextAction(
    state: AgentState,
    toolRegistry: ReturnType<typeof createToolRegistry>,
    tokenUsage: TokenUsage,
    lastEval: EvaluationResult | null,
    signal?: AbortSignal
  ): Promise<ToolDecision> {
    const toolDescriptions = formatToolDescriptions(toolRegistry)

    const historyText =
      state.toolCallHistory.length === 0
        ? "No tools called yet."
        : state.toolCallHistory
            .map(
              (tc, i) =>
                `Step ${i + 1} — ${tc.toolName}\n` +
                `Input: ${JSON.stringify(tc.input)}\n` +
                `Output: ${tc.output}`
            )
            .join("\n\n")

    const evalFeedback =
      lastEval !== null
        ? `\nLAST EVALUATION: ${(lastEval.overallScore * 100).toFixed(0)}%\n` +
          `RETRY REASON: ${lastEval.retryReason}\n` +
          (lastEval.suggestedQuery ? `SUGGESTED QUERY: "${lastEval.suggestedQuery}"` : "")
        : ""

    const prompt = `You are a research assistant deciding the next action.

USER QUERY: ${state.userQuery}

AVAILABLE TOOLS:
${toolDescriptions}
- DONE: When you have enough high-quality information.

HISTORY (${state.iterationCount}/${MAX_ITERATIONS} steps):
${wrapInContext(historyText)}
${evalFeedback}
${CONTEXT_DATA_RULE}

RULES:
1. If evaluation score >= 70% and query is fully addressed: DONE.
2. If score < 70%: use rag_search with the SUGGESTED QUERY if provided.
3. Never repeat an identical search query.
4. After 4+ searches: DONE.

Respond ONLY with valid JSON:
{"toolName": "tool_name", "input": {"key": "value"}, "reason": "brief reason"}`

    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, topP: 1.0, maxOutputTokens: 4096 },
    }

    requestBody.generationConfig!.responseMimeType = "application/json"

    const response = await this.callGemini(requestBody, signal)
    tokenUsage.total += response.usageMetadata?.totalTokenCount ?? 0

    const decision = parseToolDecision(geminiText(response))
    const retryQuery = lastEval?.suggestedQuery?.trim()
    if (
      decision.toolName === "DONE" &&
      lastEval?.shouldRetry &&
      retryQuery &&
      !state.toolCallHistory.some(tc => tc.input["query"] === retryQuery)
    ) {
      return { toolName: "rag_search", input: { query: retryQuery }, reason: lastEval.retryReason }
    }
    return decision
  }

  private async draftAnswer(
    state: AgentState,
    tokenUsage: TokenUsage,
    signal?: AbortSignal
  ): Promise<string> {
    if (state.toolCallHistory.length === 0) return ""

    const evidence = state.toolCallHistory
      .filter(tc => tc.success)
      .map((tc, i) => `[Evidence ${i + 1}] (${tc.toolName}): ${tc.output}`)
      .join("\n\n")

    const prompt = `Draft a concise answer using ONLY the evidence below.
QUERY: ${state.userQuery}
EVIDENCE:
${wrapInContext(evidence)}
${CONTEXT_DATA_RULE}
Draft (2-4 sentences):`

    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, topP: 1.0, maxOutputTokens: 4096 },
    }

    try {
      const response = await this.callGemini(requestBody, signal)
      tokenUsage.total += response.usageMetadata?.totalTokenCount ?? 0
      return geminiText(response)
    } catch (error: unknown) {
      // Aborts must stop the run — do not swallow them into an empty draft.
      if (signal?.aborted || error instanceof RateLimitError) throw error
      return ""
    }
  }

  private async synthesiseFinalAnswer(
    state: AgentState,
    tokenUsage: TokenUsage,
    signal?: AbortSignal
  ): Promise<{ answer: string; citations: Citation[] }> {
    if (state.toolCallHistory.length === 0) {
      const result = await this.generationService.generateWithFallback(state.userQuery)
      return { answer: result.answer, citations: [] }
    }

    const evidence = state.toolCallHistory
      .filter(tc => tc.success)
      .map(
        (tc, i) =>
          `[Evidence ${i + 1}] (${tc.toolName}, input: ${JSON.stringify(tc.input)})\n${tc.output}`
      )
      .join("\n\n---\n\n")

    const prompt = `Answer using ONLY the evidence below.
QUESTION: ${state.userQuery}
EVIDENCE:
${wrapInContext(evidence)}
${CONTEXT_DATA_RULE}
RULES:
1. Only use information from the evidence.
2. If insufficient: say "Based on the available documents, I could not find a complete answer."
3. Cite evidence as [Evidence N].
4. Be concise and factual.`

    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, topP: 0.8, maxOutputTokens: 4096 },
    }

    const response = await this.callGemini(requestBody, signal)
    tokenUsage.total += response.usageMetadata?.totalTokenCount ?? 0

    return {
      answer: geminiText(response),
      citations: extractCitationsFromHistory(state.toolCallHistory),
    }
  }

  private async callGemini(
    requestBody: GeminiRequest,
    signal?: AbortSignal
  ): Promise<GeminiResponse> {
    const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`
    return requestGemini(url, this.apiKey, requestBody, signal)
  }
}
