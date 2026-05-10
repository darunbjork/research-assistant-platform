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

// ── Constants ──────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const MAX_ITERATIONS = 5

// ── Event Callback Type ────────────────────────────────────────────────────
// The WebSocket handler passes this function to the streaming service.
// Every event the service produces is routed through this callback.
export type AgentEventCallback = (message: ServerMessage) => void

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
    onEvent: AgentEventCallback
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

    // ── ReAct + Self-Correction Loop ───────────────────────────────────
    while (!state.isComplete && state.iterationCount < MAX_ITERATIONS) {
      state.iterationCount++
      state.status = "thinking"

      // ── REASON ────────────────────────────────────────────────────
      let decision: ToolDecision
      try {
        decision = await this.reasonNextAction(state, toolRegistry, tokenUsage, lastEval)
      } catch (error: unknown) {
        logError("Streaming agent reasoning failed", error, {
          service: "StreamingAgentService",
          sessionId,
        })

        this.emit(onEvent, {
          type: "error",
          sessionId,
          message: error instanceof Error ? error.message : "Reasoning failed",
          code: "REASONING_ERROR",
        })
        break
      }

      // ── CHECK: DONE ───────────────────────────────────────────────
      if (decision.toolName === "DONE") {
        const doneStep: AgentStep = {
          stepNumber: state.iterationCount,
          description: "Determined sufficient information gathered",
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
      const toolStatus =
        decision.toolName === "rag_search"
          ? "searching"
          : decision.toolName === "calculator"
            ? "calculating"
            : "searching"

      this.emit(onEvent, {
        type: "status",
        status: toolStatus,
        sessionId,
        message: this.describeStep(decision),
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
        description: this.describeStep(decision),
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

        state.draftAnswer = await this.draftAnswer(state, tokenUsage)

        const evalStart = Date.now()
        lastEval = await this.evaluator.evaluate({
          userQuery: state.userQuery,
          toolCallHistory: state.toolCallHistory,
          draftAnswer: state.draftAnswer,
          iterationCount: state.iterationCount,
          maxIterations: MAX_ITERATIONS,
        })

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
    state.status = "generating"

    this.emit(onEvent, {
      type: "status",
      status: "generating",
      sessionId,
      message: "Writing your answer...",
    })

    const { answer, citations } = await this.synthesiseFinalAnswer(state, tokenUsage)

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
    lastEval: EvaluationResult | null
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
                `Output: ${tc.output.slice(0, 250)}`
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
${historyText}
${evalFeedback}

RULES:
1. If evaluation score >= 70% and query is fully addressed: DONE.
2. If score < 70%: use rag_search with the SUGGESTED QUERY if provided.
3. Never repeat an identical search query.
4. After 4+ searches: DONE.

Respond ONLY with valid JSON:
{"toolName": "tool_name", "input": {"key": "value"}, "reason": "brief reason"}`

    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, topP: 1.0, maxOutputTokens: 256 },
    }

    const response = await this.callGemini(requestBody)
    tokenUsage.total += response.usageMetadata.totalTokenCount

    return this.parseToolDecision(response.candidates[0]?.content.parts[0]?.text ?? "")
  }

  private async draftAnswer(state: AgentState, tokenUsage: TokenUsage): Promise<string> {
    if (state.toolCallHistory.length === 0) return ""

    const evidence = state.toolCallHistory
      .filter(tc => tc.success)
      .map((tc, i) => `[Evidence ${i + 1}] (${tc.toolName}): ${tc.output.slice(0, 400)}`)
      .join("\n\n")

    const prompt = `Draft a concise answer using ONLY the evidence below.
QUERY: ${state.userQuery}
EVIDENCE:
${evidence}
Draft (2-4 sentences):`

    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, topP: 1.0, maxOutputTokens: 256 },
    }

    try {
      const response = await this.callGemini(requestBody)
      tokenUsage.total += response.usageMetadata.totalTokenCount
      return response.candidates[0]?.content.parts[0]?.text ?? ""
    } catch {
      return ""
    }
  }

  private async synthesiseFinalAnswer(
    state: AgentState,
    tokenUsage: TokenUsage
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
${evidence}
RULES:
1. Only use information from the evidence.
2. If insufficient: say "Based on the available documents, I could not find a complete answer."
3. Cite evidence as [Evidence N].
4. Be concise and factual.`

    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, topP: 0.8, maxOutputTokens: 1024 },
    }

    const response = await this.callGemini(requestBody)
    tokenUsage.total += response.usageMetadata.totalTokenCount

    return {
      answer: response.candidates[0]?.content.parts[0]?.text ?? "",
      citations: this.extractCitationsFromHistory(state.toolCallHistory),
    }
  }

  private parseToolDecision(rawText: string): ToolDecision {
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
      if (typeof parsed.toolName !== "string") throw new Error("No toolName")
      return {
        toolName: parsed.toolName,
        input:
          typeof parsed.input === "object" && parsed.input !== null
            ? (parsed.input as Record<string, string>)
            : {},
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      }
    } catch {
      return { toolName: "DONE", input: {}, reason: "Parse error" }
    }
  }

  private extractCitationsFromHistory(toolCalls: ToolCall[]): Citation[] {
    const citations: Citation[] = []
    toolCalls
      .filter(tc => tc.toolName === "rag_search" && tc.success)
      .forEach(tc => {
        const pattern =
          /\[Result \d+\] \(source: ([^,)]+)(?:, page (\d+))?, relevance: ([\d.]+)\)\n([\s\S]*?)(?=---|\[Result|$)/g
        let match = pattern.exec(tc.output)
        while (match !== null) {
          const [, sourceName, pageStr, scoreStr, content] = match
          if (sourceName && content) {
            citations.push({
              chunkId: `stream-${Date.now()}-${citations.length}`,
              documentId: "stream-retrieved",
              documentName: sourceName.trim(),
              pageNumber: pageStr ? parseInt(pageStr, 10) : undefined,
              excerpt: content.trim().slice(0, 200),
              relevanceScore: parseFloat(scoreStr ?? "0"),
            })
          }
          match = pattern.exec(tc.output)
        }
      })
    return citations
  }

  private describeStep(decision: ToolDecision): string {
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

  private async callGemini(requestBody: GeminiRequest): Promise<GeminiResponse> {
    const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })
    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`)
    }
    return response.json() as Promise<GeminiResponse>
  }
}
