import { geminiText } from "../../utils/gemini-response"
import type { HybridSearchService } from "../../services/hybrid.search.service"
import type { GenerationService } from "../../services/generation.service"
import type {
  AgentState,
  AgentResult,
  AgentStep,
  ToolCall,
  ToolDecision,
} from "../../types/agent.types"
import type { GeminiRequest, GeminiResponse } from "../../types/llm.types"
import type { Citation } from "../../types/retrieval.types"
import type { ServerMessage } from "../../types/websocket.types"
import { createToolRegistry } from "../tools/index"
import { classifyQuery } from "../nodes/classify.node"
import { EvaluatorNode } from "../nodes/evaluate.node"
import type { EvaluationResult } from "../nodes/evaluate.node"
import { logRagEvent, logError } from "../../utils/logger"
import { agentIterations, activeAgentSessions } from "../../utils/metrics"
import { requestGemini } from "../../utils/gemini-request"
import { RateLimitError } from "../../middleware/error.middleware"
import { env } from "../../config/env"
import { getTracer } from "../../telemetry/tracer"
import { withSpan, LLM_ATTRS, RAG_ATTRS } from "../../telemetry/spans"
import { parseToolDecision } from "./decision"
import { extractCitationsFromHistory } from "./citations"
import { describeStep, statusForTool } from "./steps"
import {
  buildDraftPrompt,
  buildReasoningPrompt,
  buildSynthesisPrompt,
  DRAFT_GENERATION_CONFIG,
  REASONING_GENERATION_CONFIG,
  SYNTHESIS_GENERATION_CONFIG,
} from "./prompts"
import type { AgentEventCallback, AgentRunParams } from "./types"

const GEMINI_MODEL = env.GEMINI_GENERATION_MODEL
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const MAX_ITERATIONS = 5

interface TokenUsage {
  total: number
}

export class AgentEngine {
  private readonly evaluator: EvaluatorNode
  private readonly tracer = getTracer("agent.engine")

  constructor(
    private readonly apiKey: string,
    private readonly hybridSearchService: HybridSearchService,
    private readonly generationService: GenerationService
  ) {
    this.evaluator = new EvaluatorNode(apiKey)
  }

  async run(params: AgentRunParams): Promise<AgentResult> {
    const { query: userQuery, userId, sessionId, signal, onEvent, transport } = params
    return withSpan(this.tracer, "agent.run", async span => {
      const startedAt = new Date()
      const steps: AgentStep[] = []
      const tokenUsage: TokenUsage = { total: 0 }
      let lastEval: EvaluationResult | null = null

      span.setAttribute(RAG_ATTRS.QUERY, userQuery.slice(0, 200))
      span.setAttribute("agent.session_id", sessionId)
      span.setAttribute("agent.user_id", userId)
      span.setAttribute("agent.transport", transport)

      this.emit(
        onEvent,
        {
          type: "status",
          status: "thinking",
          sessionId,
          message: "Analysing your question...",
        },
        transport
      )

      logRagEvent("agent_step", "Agent session started", {
        service: "AgentEngine",
        sessionId,
        userId,
        transport,
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
      activeAgentSessions.inc()
      try {
        while (!state.isComplete && state.iterationCount < MAX_ITERATIONS) {
          if (signal?.aborted) {
            state.status = "aborted"
            break
          }
          state.iterationCount++
          state.status = "thinking"

          let decision: ToolDecision
          try {
            decision = await withSpan(this.tracer, "agent.reason", async reasonSpan => {
              reasonSpan.setAttribute(RAG_ATTRS.ITERATION, state.iterationCount)
              return this.reasonNextAction(state, toolRegistry, tokenUsage, lastEval, signal)
            })
          } catch (error: unknown) {
            if (signal?.aborted) {
              state.status = "aborted"
              break
            }
            logError("Agent session reasoning failed", error, {
              service: "AgentEngine",
              sessionId,
              transport,
            })
            throw error
          }

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
            this.emit(onEvent, { type: "step", sessionId, step: doneStep }, transport)
            state.isComplete = true
            break
          }

          const tool = toolRegistry[decision.toolName]
          if (tool === undefined) {
            logRagEvent("agent_step", `Unknown tool: ${decision.toolName}`, {
              service: "AgentEngine",
              sessionId,
              transport,
            })
            continue
          }

          this.emit(
            onEvent,
            {
              type: "status",
              status: statusForTool(decision.toolName),
              sessionId,
              message: describeStep(decision),
            },
            transport
          )

          const toolStart = Date.now()
          let toolOutput = ""
          let toolSuccess = true
          let toolError: string | undefined

          try {
            toolOutput = await withSpan(
              this.tracer,
              `agent.tool.${decision.toolName}`,
              async toolSpan => {
                toolSpan.setAttribute(RAG_ATTRS.TOOL_NAME, decision.toolName)
                toolSpan.setAttribute(RAG_ATTRS.ITERATION, state.iterationCount)
                return tool.execute(decision.input, { signal })
              }
            )
          } catch (error: unknown) {
            // Rethrow aborts and Gemini rate limits so callers can stop cleanly / honour Retry-After.
            // A per-call timeout (TimeoutError) while the caller's signal is still live is treated
            // as a tool failure and recorded as a failed step so the loop can continue.
            if (signal?.aborted || error instanceof RateLimitError) throw error
            toolSuccess = false
            toolError = error instanceof Error ? error.message : "Tool execution failed"
            toolOutput = `Tool error: ${toolError}`
            logError(`Tool ${decision.toolName} failed`, error, {
              service: "AgentEngine",
              sessionId,
              transport,
            })
          }

          const toolDurationMs = Date.now() - toolStart
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
          this.emit(onEvent, { type: "step", sessionId, step }, transport)

          if (toolSuccess && state.toolCallHistory.length > 0) {
            state.status = "evaluating"
            this.emit(
              onEvent,
              {
                type: "status",
                status: "evaluating",
                sessionId,
                message: "Checking answer quality...",
              },
              transport
            )

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

            this.emit(
              onEvent,
              {
                type: "quality",
                sessionId,
                score: lastEval.overallScore,
                shouldRetry: lastEval.shouldRetry,
                retryReason: lastEval.retryReason,
                suggestedQuery: lastEval.suggestedQuery,
              },
              transport
            )

            const evalStep: AgentStep = {
              stepNumber: state.iterationCount,
              description:
                `Quality check: ${(lastEval.overallScore * 100).toFixed(0)}% ` +
                (lastEval.shouldRetry ? `— retrying (${lastEval.retryReason})` : "— sufficient ✓"),
              durationMs: Date.now() - evalStart,
              timestamp: new Date(),
            }
            steps.push(evalStep)
            this.emit(onEvent, { type: "step", sessionId, step: evalStep }, transport)

            logRagEvent("agent_step", "Self-evaluation complete", {
              service: "AgentEngine",
              sessionId,
              transport,
              similarity: lastEval.overallScore,
            })

            if (!lastEval.shouldRetry) {
              state.isComplete = true
              break
            }

            this.emit(
              onEvent,
              {
                type: "status",
                status: "thinking",
                sessionId,
                message: "Quality below threshold — searching again...",
              },
              transport
            )
          }
        }

        if (signal?.aborted) {
          return this.buildAbortedResult(state, steps, tokenUsage, startedAt, onEvent, transport)
        }

        state.status = "generating"
        this.emit(
          onEvent,
          {
            type: "status",
            status: "generating",
            sessionId,
            message: "Writing your answer...",
          },
          transport
        )

        const { answer, citations } = await this.synthesiseFinalAnswer(state, tokenUsage, signal)
        state.finalAnswer = answer
        state.citations = citations
        state.status = "done"
        state.completedAt = new Date()

        const totalDurationMs = Date.now() - startedAt.getTime()
        span.setAttribute(RAG_ATTRS.QUALITY_SCORE, state.qualityScore)
        span.setAttribute("agent.iterations", state.iterationCount)
        span.setAttribute(LLM_ATTRS.TOTAL_TOKENS, tokenUsage.total)

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

        this.emit(onEvent, { type: "complete", sessionId, result: finalResult }, transport)

        logRagEvent("agent_step", "Agent session complete", {
          service: "AgentEngine",
          sessionId,
          transport,
          iterationCount: state.iterationCount,
          durationMs: totalDurationMs,
        })

        return finalResult
      } catch (error: unknown) {
        if (signal?.aborted) {
          return this.buildAbortedResult(state, steps, tokenUsage, startedAt, onEvent, transport)
        }
        throw error
      } finally {
        activeAgentSessions.dec()
      }
    })
  }

  private buildAbortedResult(
    state: AgentState,
    steps: AgentStep[],
    tokenUsage: TokenUsage,
    startedAt: Date,
    onEvent: AgentEventCallback | undefined,
    transport: AgentRunParams["transport"]
  ): AgentResult {
    state.status = "aborted"
    state.completedAt = new Date()
    const abortedResult: AgentResult = {
      sessionId: state.sessionId,
      finalAnswer: state.finalAnswer,
      citations: state.citations,
      steps,
      iterationCount: state.iterationCount,
      status: "aborted",
      tokensUsed: tokenUsage.total,
      durationMs: Date.now() - startedAt.getTime(),
    }
    this.emit(
      onEvent,
      {
        type: "status",
        status: "aborted",
        sessionId: state.sessionId,
        message: "Request cancelled",
      },
      transport
    )
    logRagEvent("agent_step", "Agent session aborted", {
      service: "AgentEngine",
      sessionId: state.sessionId,
      transport,
      iterationCount: state.iterationCount,
    })
    return abortedResult
  }

  private emit(
    onEvent: AgentEventCallback | undefined,
    message: ServerMessage,
    transport: AgentRunParams["transport"]
  ): void {
    if (onEvent === undefined) return
    try {
      onEvent(message)
    } catch (error: unknown) {
      logError("Event callback threw", error, { service: "AgentEngine", transport })
    }
  }

  private async reasonNextAction(
    state: AgentState,
    toolRegistry: ReturnType<typeof createToolRegistry>,
    tokenUsage: TokenUsage,
    lastEval: EvaluationResult | null,
    signal?: AbortSignal
  ): Promise<ToolDecision> {
    const prompt = buildReasoningPrompt(state, toolRegistry, lastEval, MAX_ITERATIONS)
    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { ...REASONING_GENERATION_CONFIG },
    }
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
    const prompt = buildDraftPrompt(state)
    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { ...DRAFT_GENERATION_CONFIG },
    }
    try {
      const response = await this.callGemini(requestBody, signal)
      tokenUsage.total += response.usageMetadata?.totalTokenCount ?? 0
      return geminiText(response)
    } catch (error: unknown) {
      // V12 preserved: aborts/429 rethrow; other errors swallowed to empty draft
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
    const prompt = buildSynthesisPrompt(state)
    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { ...SYNTHESIS_GENERATION_CONFIG },
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
