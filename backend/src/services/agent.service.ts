// backend/src/services/agent.service.ts
// Updated Day 22: spans on every ReAct iteration.

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
import { getTracer } from "../telemetry/tracer"
import { withSpan, LLM_ATTRS, RAG_ATTRS } from "../telemetry/spans"

// ── Constants ──────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const MAX_ITERATIONS = 5

// ── Token tracking ─────────────────────────────────────────────────────────
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

  // ── run ───────────────────────────────────────────────────────────────
  async run(userQuery: string, userId: string): Promise<AgentResult> {
    return withSpan(this.tracer, "agent.run", async span => {
      const sessionId = crypto.randomUUID()
      const startedAt = new Date()
      const steps: AgentStep[] = []
      const tokenUsage: TokenUsage = { total: 0 }
      let lastEval: EvaluationResult | null = null

      activeAgentSessions.inc()

      logRagEvent("agent_step", "Agent session started", {
        service: "AgentService",
        sessionId,
        userId,
      })

      span.setAttribute(RAG_ATTRS.QUERY, userQuery.slice(0, 200))
      span.setAttribute("agent.session_id", sessionId)
      span.setAttribute("agent.user_id", userId)

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

        logRagEvent("agent_step", `ReAct iteration ${state.iterationCount}`, {
          service: "AgentService",
          sessionId,
          iterationCount: state.iterationCount,
        })

        // ── REASON ──────────────────────────────────────────────────────
        let decision: ToolDecision

        try {
          decision = await withSpan(this.tracer, "agent.reason", async reasonSpan => {
            reasonSpan.setAttribute(RAG_ATTRS.ITERATION, state.iterationCount)
            return this.reasonNextAction(state, toolRegistry, tokenUsage, lastEval)
          })
        } catch (error: unknown) {
          logError("Agent reasoning failed", error, { service: "AgentService", sessionId })
          state.status = "error"
          state.error = error instanceof Error ? error.message : "Reasoning failed"
          break
        }

        // ── CHECK: Agent says DONE ──────────────────────────────────────
        if (decision.toolName === "DONE") {
          steps.push({
            stepNumber: state.iterationCount,
            description: "Determined sufficient information gathered",
            durationMs: 0,
            timestamp: new Date(),
          })
          state.isComplete = true
          break
        }

        // ── ACT ────────────────────────────────────────────────────────
        const tool = toolRegistry[decision.toolName]

        if (tool === undefined) {
          logRagEvent("agent_step", `Unknown tool: ${decision.toolName}`, {
            service: "AgentService",
            sessionId,
          })
          continue
        }

        this.updateStatusForTool(state, decision.toolName)

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

        // ── OBSERVE ────────────────────────────────────────────────────
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
          description: this.describeStep(decision),
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

        // ── DRAFT + EVALUATE ────────────────────────────────────────────
        if (toolSuccess && state.toolCallHistory.length > 0) {
          state.status = "evaluating"

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

      // ── SYNTHESISE ────────────────────────────────────────────────────
      state.status = "generating"

      const { answer, citations } = await this.synthesiseFinalAnswer(state, tokenUsage)

      state.finalAnswer = answer
      state.citations = citations
      state.status = "done"
      state.isComplete = true
      state.completedAt = new Date()

      activeAgentSessions.dec()

      const totalDurationMs = Date.now() - startedAt.getTime()

      span.setAttribute(RAG_ATTRS.QUALITY_SCORE, state.qualityScore)
      span.setAttribute("agent.iterations", state.iterationCount)
      span.setAttribute(LLM_ATTRS.TOTAL_TOKENS, tokenUsage.total)

      logRagEvent("agent_step", "Agent session complete", {
        service: "AgentService",
        sessionId,
        iterationCount: state.iterationCount,
        similarity: state.qualityScore,
        durationMs: totalDurationMs,
      })

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
    })
  }

  // ── draftAnswer ───────────────────────────────────────────────────────
  private async draftAnswer(state: AgentState, tokenUsage: TokenUsage): Promise<string> {
    if (state.toolCallHistory.length === 0) {
      return ""
    }

    const evidence = state.toolCallHistory
      .filter((tc: ToolCall) => tc.success)
      .map(
        (tc: ToolCall, i: number) =>
          `[Evidence ${i + 1}] (${tc.toolName}): ${tc.output.slice(0, 400)}`
      )
      .join("\n\n")

    const draftPrompt = `Based on this evidence, draft a concise answer to the query.
Use ONLY information from the evidence. If insufficient, say so.

QUERY: ${state.userQuery}

EVIDENCE:
${evidence}

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
        maxOutputTokens: 256,
      },
    }

    try {
      const response = await this.callGemini(requestBody)
      tokenUsage.total += response.usageMetadata?.totalTokenCount ?? 0
      return response.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
    } catch {
      return ""
    }
  }

  // ── reasonNextAction ──────────────────────────────────────────────────
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
              (tc: ToolCall, i: number) =>
                `Step ${i + 1} — ${tc.toolName}\n` +
                `Input: ${JSON.stringify(tc.input)}\n` +
                `Output: ${tc.output.slice(0, 250)}`
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
${historyText}
${evalFeedback}

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
        maxOutputTokens: 256,
      },
    }

    const response = await this.callGemini(requestBody)
    tokenUsage.total += response.usageMetadata?.totalTokenCount ?? 0

    const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
    return this.parseToolDecision(rawText)
  }

  // ── synthesiseFinalAnswer ─────────────────────────────────────────────
  private async synthesiseFinalAnswer(
    state: AgentState,
    tokenUsage: TokenUsage
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
${evidence}

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
        maxOutputTokens: 1024,
      },
    }

    const response = await this.callGemini(requestBody)
    tokenUsage.total += response.usageMetadata?.totalTokenCount ?? 0

    const answer = response.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
    const citations = this.extractCitationsFromHistory(state.toolCallHistory)

    return { answer, citations }
  }

  // ── updateStatusForTool ───────────────────────────────────────────────
  private updateStatusForTool(state: AgentState, toolName: string): void {
    if (toolName === "rag_search") state.status = "searching"
    else if (toolName === "calculator") state.status = "calculating"
    else state.status = "searching"
  }

  // ── parseToolDecision ─────────────────────────────────────────────────
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
      logRagEvent("agent_step", "Failed to parse tool decision — defaulting to DONE", {
        service: "AgentService",
      })
      return { toolName: "DONE", input: {}, reason: "Parse error" }
    }
  }

  // ── extractCitationsFromHistory ───────────────────────────────────────
  private extractCitationsFromHistory(toolCalls: ToolCall[]): Citation[] {
    const citations: Citation[] = []

    toolCalls
      .filter((tc: ToolCall) => tc.toolName === "rag_search" && tc.success)
      .forEach((tc: ToolCall) => {
        const sourcePattern =
          /\[Result \d+\] \(source: ([^,)]+)(?:, page (\d+))?, relevance: ([\d.]+)\)\n([\s\S]*?)(?=---|\[Result|$)/g

        let match = sourcePattern.exec(tc.output)
        while (match !== null) {
          const [, sourceName, pageStr, scoreStr, content] = match

          if (sourceName && content) {
            citations.push({
              chunkId: `agent-${Date.now()}-${citations.length}`,
              documentId: "agent-retrieved",
              documentName: sourceName.trim(),
              pageNumber: pageStr ? parseInt(pageStr, 10) : undefined,
              excerpt: content.trim().slice(0, 200),
              relevanceScore: parseFloat(scoreStr ?? "0"),
            })
          }

          match = sourcePattern.exec(tc.output)
        }
      })

    return citations
  }

  // ── describeStep ──────────────────────────────────────────────────────
  private describeStep(decision: ToolDecision): string {
    switch (decision.toolName) {
      case "rag_search":
        return `Searching documents: "${decision.input["query"] ?? ""}"`
      case "calculator":
        return `Calculating: ${decision.input["expression"] ?? ""}`
      case "web_search":
        return `Searching the web: "${decision.input["query"] ?? ""}"`
      default:
        return `Running tool: ${decision.toolName}`
    }
  }

  // ── callGemini ────────────────────────────────────────────────────────
  private async callGemini(requestBody: GeminiRequest): Promise<GeminiResponse> {
    const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      let msg = `Gemini API error: ${response.status} ${response.statusText}`
      try {
        const body = (await response.json()) as { error?: { message?: string } }
        if (body.error?.message) msg += ` — ${body.error.message}`
      } catch {
        /* ignore */
      }
      throw new Error(msg)
    }

    return response.json() as Promise<GeminiResponse>
  }
}
