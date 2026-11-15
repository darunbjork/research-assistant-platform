import { geminiText } from "../utils/gemini-response"
import crypto from "crypto"
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
import { createToolRegistry, formatToolDescriptions } from "../agents/tools/index"
import { classifyQuery } from "../agents/nodes/classify.node"
import { EvaluatorNode } from "../agents/nodes/evaluate.node"
import type { EvaluationResult } from "../agents/nodes/evaluate.node"
import { logRagEvent, logError } from "../utils/logger"
import { agentIterations, activeAgentSessions } from "../utils/metrics"
import { requestGemini } from "../utils/gemini-request"
import { RateLimitError } from "../middleware/error.middleware"
import { env } from "../config/env"
import { CONTEXT_DATA_RULE, wrapInContext } from "../utils/prompt-boundary"
import { getTracer } from "../telemetry/tracer"
import { parseToolDecision } from "../agents/engine/decision"
import { extractCitationsFromHistory } from "../agents/engine/citations"
import { describeStep, statusForTool } from "../agents/engine/steps"
import { withSpan, LLM_ATTRS, RAG_ATTRS } from "../telemetry/spans"

const GEMINI_MODEL = env.GEMINI_GENERATION_MODEL
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const MAX_ITERATIONS = 5
interface TokenUsage {
  total: number
}

export class AgentService {
  private readonly evaluator: EvaluatorNode
  private readonly tracer = getTracer("agent.service")

  constructor(
    private readonly apiKey: string,
    private readonly hybridSearchService: HybridSearchService,
    private readonly generationService: GenerationService
  ) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error("AgentService requires a Gemini API key")
    }
    this.evaluator = new EvaluatorNode(apiKey)
  }

  async run(userQuery: string, userId: string, signal?: AbortSignal): Promise<AgentResult> {
    return withSpan(this.tracer, "agent.run", async span => {
      const sessionId = crypto.randomUUID()
      const startedAt = new Date()
      const steps: AgentStep[] = []
      const tokenUsage: TokenUsage = { total: 0 }
      let lastEval: EvaluationResult | null = null

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

      activeAgentSessions.inc()
      try {
        logRagEvent("agent_step", "Agent session started", {
          service: "AgentService",
          sessionId,
          userId,
        })

        span.setAttribute(RAG_ATTRS.QUERY, userQuery.slice(0, 200))
        span.setAttribute("agent.session_id", sessionId)
        span.setAttribute("agent.user_id", userId)

        const toolRegistry = createToolRegistry(this.hybridSearchService, userId)
        while (!state.isComplete && state.iterationCount < MAX_ITERATIONS) {
          if (signal?.aborted) {
            state.status = "aborted"
            logRagEvent("agent_step", "Agent run aborted", {
              service: "AgentService",
              sessionId,
            })
            break
          }
          state.iterationCount++
          state.status = "thinking"

          logRagEvent("agent_step", `ReAct iteration ${state.iterationCount}`, {
            service: "AgentService",
            sessionId,
            iterationCount: state.iterationCount,
          })

          let decision: ToolDecision

          try {
            decision = await withSpan(this.tracer, "agent.reason", async reasonSpan => {
              reasonSpan.setAttribute(RAG_ATTRS.ITERATION, state.iterationCount)
              return this.reasonNextAction(state, toolRegistry, tokenUsage, lastEval, signal)
            })
          } catch (error: unknown) {
            if (signal?.aborted) {
              state.status = "aborted"
              logRagEvent("agent_step", "Agent run aborted during reasoning", {
                service: "AgentService",
                sessionId,
              })
              break
            }
            logError("Agent reasoning failed", error, { service: "AgentService", sessionId })
            throw error
          }

          if (decision.toolName === "DONE") {
            steps.push({
              stepNumber: state.iterationCount,
              description: lastEval?.shouldRetry
                ? "Search completed; evidence may be incomplete"
                : "Determined sufficient information gathered",
              durationMs: 0,
              timestamp: new Date(),
            })
            state.isComplete = true
            break
          }

          const tool = toolRegistry[decision.toolName]

          if (tool === undefined) {
            logRagEvent("agent_step", `Unknown tool: ${decision.toolName}`, {
              service: "AgentService",
              sessionId,
            })
            continue
          }

          state.status = statusForTool(decision.toolName)

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
                return tool.execute(decision.input)
              }
            )
          } catch (error: unknown) {
            toolSuccess = false
            toolError = error instanceof Error ? error.message : "Tool execution failed"
            toolOutput = `Tool error: ${toolError}`
            logError(`Tool ${decision.toolName} failed`, error, {
              service: "AgentService",
              sessionId,
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

          steps.push({
            stepNumber: state.iterationCount,
            description: describeStep(decision),
            toolUsed: decision.toolName,
            durationMs: toolDurationMs,
            timestamp: new Date(),
          })

          logRagEvent("agent_step", "Tool executed", {
            service: "AgentService",
            sessionId,
            toolName: decision.toolName,
            durationMs: toolDurationMs,
          })

          if (toolSuccess && state.toolCallHistory.length > 0) {
            state.status = "evaluating"

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

            const evalMs = Date.now() - evalStart

            steps.push({
              stepNumber: state.iterationCount,
              description:
                `Quality check: ${(lastEval.overallScore * 100).toFixed(0)}% ` +
                (lastEval.shouldRetry ? `— retrying (${lastEval.retryReason})` : "— sufficient ✓"),
              toolUsed: undefined,
              durationMs: evalMs,
              timestamp: new Date(),
            })

            logRagEvent("agent_step", "Self-evaluation complete", {
              service: "AgentService",
              sessionId,
              similarity: lastEval.overallScore,
              iterationCount: state.iterationCount,
            })

            if (!lastEval.shouldRetry) {
              logRagEvent("agent_step", "Quality threshold met — stopping loop", {
                service: "AgentService",
                sessionId,
                similarity: lastEval.overallScore,
              })
              state.isComplete = true
              break
            }

            logRagEvent("agent_step", "Quality below threshold — retrying", {
              service: "AgentService",
              sessionId,
              similarity: lastEval.overallScore,
            })
          }
        }

        if (signal?.aborted) {
          state.status = "aborted"
          state.isComplete = true
          state.completedAt = new Date()
        } else {
          state.status = "generating"

          const { answer, citations } = await this.synthesiseFinalAnswer(state, tokenUsage, signal)

          state.finalAnswer = answer
          state.citations = citations
          state.status = "done"
          state.isComplete = true
          state.completedAt = new Date()
        }

        const totalDurationMs = Date.now() - startedAt.getTime()

        span.setAttribute(RAG_ATTRS.QUALITY_SCORE, state.qualityScore)
        span.setAttribute("agent.iterations", state.iterationCount)
        span.setAttribute(LLM_ATTRS.TOTAL_TOKENS, tokenUsage.total)

        if (state.status === "aborted") {
          logRagEvent("agent_step", "Agent session aborted", {
            service: "AgentService",
            sessionId,
            iterationCount: state.iterationCount,
            durationMs: totalDurationMs,
          })
        } else {
          logRagEvent("agent_step", "Agent session complete", {
            service: "AgentService",
            sessionId,
            iterationCount: state.iterationCount,
            similarity: state.qualityScore,
            durationMs: totalDurationMs,
          })
        }

        return {
          sessionId,
          finalAnswer: state.finalAnswer,
          citations: state.citations,
          steps,
          iterationCount: state.iterationCount,
          status: state.status,
          tokensUsed: tokenUsage.total,
          durationMs: totalDurationMs,
        }
      } catch (error: unknown) {
        // Aborted mid-call (client disconnect / WS close): report "aborted",
        // never as a failure — logged at info, no error status.
        if (signal?.aborted) {
          state.status = "aborted"
          state.completedAt = new Date()
          logRagEvent("agent_step", "Agent session aborted", {
            service: "AgentService",
            sessionId,
            userId,
            iterationCount: state.iterationCount,
          })
          return {
            sessionId,
            finalAnswer: state.finalAnswer,
            citations: state.citations,
            steps,
            iterationCount: state.iterationCount,
            status: state.status,
            tokensUsed: tokenUsage.total,
            durationMs: Date.now() - startedAt.getTime(),
          }
        }
        throw error
      } finally {
        activeAgentSessions.dec()
      }
    })
  }

  private async draftAnswer(
    state: AgentState,
    tokenUsage: TokenUsage,
    signal?: AbortSignal
  ): Promise<string> {
    if (state.toolCallHistory.length === 0) {
      return ""
    }

    const evidence = state.toolCallHistory
      .filter((tc: ToolCall) => tc.success)
      .map((tc: ToolCall, i: number) => `[Evidence ${i + 1}] (${tc.toolName}): ${tc.output}`)
      .join("\n\n")

    const draftPrompt = `Based on this evidence, draft a concise answer to the query.
Use ONLY information from the evidence. If insufficient, say so.

QUERY: ${state.userQuery}

EVIDENCE:
${wrapInContext(evidence)}
${CONTEXT_DATA_RULE}

Provide a brief, direct draft answer (2-4 sentences maximum):`

    const requestBody: GeminiRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: draftPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        topP: 1.0,
        maxOutputTokens: 4096,
      },
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
              (tc: ToolCall, i: number) =>
                `Step ${i + 1} — ${tc.toolName}\n` +
                `Input: ${JSON.stringify(tc.input)}\n` +
                `Output: ${tc.output}`
            )
            .join("\n\n")

    const evalFeedback =
      lastEval !== null
        ? `\nLAST EVALUATION SCORE: ${(lastEval.overallScore * 100).toFixed(0)}%\n` +
          `RETRY REASON: ${lastEval.retryReason}\n` +
          (lastEval.suggestedQuery
            ? `SUGGESTED QUERY: "${lastEval.suggestedQuery}" — try this instead`
            : "")
        : ""

    const reasoningPrompt = `You are a research assistant deciding the next action.

USER QUERY:
${state.userQuery}

AVAILABLE TOOLS:
${toolDescriptions}
- DONE: Use when you have enough high-quality information to answer completely.

HISTORY (${state.iterationCount}/${MAX_ITERATIONS} steps used):
${wrapInContext(historyText)}
${evalFeedback}
${CONTEXT_DATA_RULE}

DECISION RULES:
1. If evaluation score >= 70% and answer covers the full query: use DONE.
2. If evaluation score < 70%: use rag_search with the SUGGESTED QUERY if provided.
3. Never repeat an identical search query from the history.
4. If you have tried 4+ searches: use DONE with what you have.

Respond ONLY with valid JSON (no markdown):
{"toolName": "tool_name", "input": {"key": "value"}, "reason": "brief reason"}`

    const requestBody: GeminiRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: reasoningPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        topP: 1.0,
        maxOutputTokens: 4096,
      },
    }

    requestBody.generationConfig!.responseMimeType = "application/json"

    const response = await this.callGemini(requestBody, signal)
    tokenUsage.total += response.usageMetadata?.totalTokenCount ?? 0

    const rawText = geminiText(response)
    const decision = parseToolDecision(rawText)
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
      .filter((tc: ToolCall) => tc.success)
      .map(
        (tc: ToolCall, i: number) =>
          `[Evidence ${i + 1}] (tool: ${tc.toolName}, ` +
          `input: ${JSON.stringify(tc.input)})\n${tc.output}`
      )
      .join("\n\n---\n\n")

    const synthesisPrompt = `You are a precise research assistant. Answer using ONLY the evidence.

QUESTION: ${state.userQuery}

EVIDENCE:
${wrapInContext(evidence)}
${CONTEXT_DATA_RULE}

RULES:
1. ONLY use information from the evidence above.
2. If evidence is insufficient, say: "Based on the available documents, I could not find a complete answer."
3. Reference evidence as [Evidence N] when citing it.
4. Be concise and factual.`

    const requestBody: GeminiRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: synthesisPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        topP: 0.8,
        maxOutputTokens: 4096,
      },
    }

    const response = await this.callGemini(requestBody, signal)
    tokenUsage.total += response.usageMetadata?.totalTokenCount ?? 0

    const answer = geminiText(response)
    const citations = extractCitationsFromHistory(state.toolCallHistory)

    return { answer, citations }
  }

  private async callGemini(
    requestBody: GeminiRequest,
    signal?: AbortSignal
  ): Promise<GeminiResponse> {
    const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`

    return requestGemini(url, this.apiKey, requestBody, signal)
  }
}
