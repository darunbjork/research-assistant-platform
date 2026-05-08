// backend/src/services/agent.service.ts
// The ReAct loop orchestrator.
//
// FULL REACT LOOP:
//
//   INIT:
//     Build initial state (sessionId, userQuery, taskType, empty history)
//
//   LOOP (max maxIterations times):
//     1. REASON: Ask the LLM: "Given the query and tool history,
//                which tool should I call next? Or am I done?"
//     2. ACT:    If tool chosen: look it up in registry, execute it
//     3. OBSERVE: Store the tool call result in toolCallHistory
//     4. CHECK:  If LLM says "DONE" or maxIterations reached: exit loop
//
//   SYNTHESISE:
//     Call Gemini once more with all tool results to produce the
//     final grounded answer with citations.
//
// DEPENDENCY INJECTION:
//   AgentService receives HybridSearchService, GenerationService
//   via constructor — never creates them internally.
//   This enables mocking in tests without real infrastructure.

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
import { logRagEvent, logError } from "../utils/logger"
import { agentIterations } from "../utils/metrics"

// ── Constants ──────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const MAX_ITERATIONS = 5

// ── Token tracking ─────────────────────────────────────────────────────────
interface TokenUsage {
  total: number
}

export class AgentService {
  private readonly tokenUsage: TokenUsage = { total: 0 }

  constructor(
    private readonly apiKey: string,
    private readonly hybridSearchService: HybridSearchService,
    private readonly generationService: GenerationService
  ) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error("AgentService requires a Gemini API key")
    }
  }

  // ── run ───────────────────────────────────────────────────────────────
  // Main entry point. Takes a user query and userId, runs the full
  // ReAct loop, and returns a final grounded answer.
  async run(userQuery: string, userId: string): Promise<AgentResult> {
    const sessionId = crypto.randomUUID()
    const startedAt = new Date()
    const steps: AgentStep[] = []
    this.tokenUsage.total = 0

    logRagEvent("agent_step", "Agent session started", {
      service: "AgentService",
      sessionId,
      userId,
    })

    // ── Initialise state ───────────────────────────────────────────────
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

    // Build the tool registry for this session
    const toolRegistry = createToolRegistry(this.hybridSearchService, userId)

    // ── ReAct Loop ─────────────────────────────────────────────────────
    while (!state.isComplete && state.iterationCount < MAX_ITERATIONS) {
      state.iterationCount++
      state.status = "thinking"

      logRagEvent("agent_step", `ReAct iteration ${state.iterationCount}`, {
        service: "AgentService",
        sessionId,
        iterationCount: state.iterationCount,
      })

      // ── REASON: Ask LLM what to do next ───────────────────────────
      let decision: ToolDecision

      try {
        decision = await this.reasonNextAction(state, toolRegistry)
      } catch (error: unknown) {
        logError("Agent reasoning failed", error, {
          service: "AgentService",
          sessionId,
        })
        state.status = "error"
        state.error = error instanceof Error ? error.message : "Reasoning failed"
        break
      }

      // ── CHECK: Is the agent done? ──────────────────────────────────
      if (decision.toolName === "DONE") {
        state.isComplete = true

        steps.push({
          stepNumber: state.iterationCount,
          description: "Determined sufficient information gathered",
          durationMs: 0,
          timestamp: new Date(),
        })

        break
      }

      // ── ACT: Execute the chosen tool ───────────────────────────────
      const tool = toolRegistry[decision.toolName]

      if (tool === undefined) {
        // LLM hallucinated a tool name — skip this iteration
        logRagEvent("agent_step", `Unknown tool requested: ${decision.toolName}`, {
          service: "AgentService",
          sessionId,
        })
        continue
      }

      // Update status to reflect which tool is running
      if (decision.toolName === "rag_search") {
        state.status = "searching"
      } else if (decision.toolName === "calculator") {
        state.status = "calculating"
      } else {
        state.status = "searching"
      }

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
          service: "AgentService",
          sessionId,
        })
      }

      const toolDurationMs = Date.now() - toolStart

      // ── OBSERVE: Record the tool call result ───────────────────────
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

      // Add to steps for frontend display
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
    }

    // ── SYNTHESISE: Generate the final answer ─────────────────────────
    state.status = "generating"

    const { answer, citations } = await this.synthesiseFinalAnswer(state)

    state.finalAnswer = answer
    state.citations = citations
    state.status = "done"
    state.isComplete = true
    state.completedAt = new Date()

    const totalDurationMs = Date.now() - startedAt.getTime()

    logRagEvent("agent_step", "Agent session complete", {
      service: "AgentService",
      sessionId,
      iterationCount: state.iterationCount,
      durationMs: totalDurationMs,
    })

    return {
      sessionId,
      finalAnswer: state.finalAnswer,
      citations: state.citations,
      steps,
      iterationCount: state.iterationCount,
      status: state.status,
      tokensUsed: this.tokenUsage.total,
      durationMs: totalDurationMs,
    }
  }

  // ── reasonNextAction ──────────────────────────────────────────────────
  // Calls the LLM to decide what the agent should do next.
  // Gives the LLM: the original query, available tools, and the full
  // history of what has been tried so far.
  // Returns: { toolName, input, reason } or { toolName: "DONE", ... }
  private async reasonNextAction(
    state: AgentState,
    toolRegistry: ReturnType<typeof createToolRegistry>
  ): Promise<ToolDecision> {
    const toolDescriptions = formatToolDescriptions(toolRegistry)

    // Build the history summary — what has been tried so far
    const historyText =
      state.toolCallHistory.length === 0
        ? "No tools have been called yet."
        : state.toolCallHistory
            .map(
              (tc, i) =>
                `Step ${i + 1} — Tool: ${tc.toolName}\n` +
                `Input: ${JSON.stringify(tc.input)}\n` +
                `Output (first 300 chars): ${tc.output.slice(0, 300)}`
            )
            .join("\n\n")

    const reasoningPrompt = `You are a research assistant deciding what action to take next.

USER QUERY:
${state.userQuery}

AVAILABLE TOOLS:
${toolDescriptions}
- DONE: Use this when you have collected enough information to answer the query fully.

WHAT YOU HAVE DONE SO FAR (${state.iterationCount} of ${MAX_ITERATIONS} maximum steps):
${historyText}

DECISION RULES:
1. If you have enough information to answer the query: respond with DONE.
2. If you need more information from documents: use rag_search.
3. If you need to calculate something: use calculator.
4. If you have tried 3+ searches with similar results: use DONE with what you have.
5. Never repeat the exact same search query you already tried.

Respond ONLY with a valid JSON object — no markdown, no explanation:
{"toolName": "tool_name", "input": {"key": "value"}, "reason": "why you chose this"}`

    const requestBody: GeminiRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: reasoningPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1, // deterministic reasoning
        topP: 1.0,
        maxOutputTokens: 256, // decisions should be short
      },
    }

    const response = await this.callGemini(requestBody)

    this.tokenUsage.total += response.usageMetadata.totalTokenCount

    const rawText = response.candidates[0]?.content.parts[0]?.text ?? ""

    return this.parseToolDecision(rawText)
  }

  // ── synthesiseFinalAnswer ─────────────────────────────────────────────
  // After the ReAct loop ends, calls Gemini one final time to produce
  // the grounded answer from all accumulated tool call results.
  private async synthesiseFinalAnswer(
    state: AgentState
  ): Promise<{ answer: string; citations: Citation[] }> {
    // If no tool calls were made (agent went straight to DONE), use GenerationService
    if (state.toolCallHistory.length === 0) {
      const result = await this.generationService.generateWithFallback(state.userQuery)
      return { answer: result.answer, citations: [] }
    }

    // Build evidence from all tool call outputs
    const evidence = state.toolCallHistory
      .filter(tc => tc.success)
      .map(
        (tc, i) =>
          `[Evidence ${i + 1}] (from tool: ${tc.toolName}, ` +
          `input: ${JSON.stringify(tc.input)})\n${tc.output}`
      )
      .join("\n\n---\n\n")

    const synthesisPrompt = `You are a precise research assistant. Answer the question using ONLY the evidence below.

QUESTION:
${state.userQuery}

EVIDENCE FROM RESEARCH:
${evidence}

RULES:
1. ONLY use information from the evidence above. Never add outside knowledge.
2. If the evidence answers the question, give a clear, direct answer.
3. If the evidence is insufficient, say: "Based on the available documents, I could not find a complete answer to this question."
4. Reference evidence as [Evidence N] when you use it.
5. Be concise and factual.`

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
    this.tokenUsage.total += response.usageMetadata.totalTokenCount

    const answer = response.candidates[0]?.content.parts[0]?.text ?? ""

    // Build citations from RAG search results in the tool history
    const citations: Citation[] = this.extractCitationsFromHistory(state.toolCallHistory)

    return { answer, citations }
  }

  // ── parseToolDecision ─────────────────────────────────────────────────
  // Parses the LLM's JSON response into a ToolDecision.
  // The LLM sometimes wraps JSON in markdown fences — we handle that.
  private parseToolDecision(rawText: string): ToolDecision {
    // Strip markdown code fences if present: ```json ... ``` → { ... }
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

      // Validate shape
      if (typeof parsed.toolName !== "string") {
        throw new Error("toolName must be a string")
      }

      const input =
        typeof parsed.input === "object" && parsed.input !== null
          ? (parsed.input as Record<string, string>)
          : {}

      const reason = typeof parsed.reason === "string" ? parsed.reason : "No reason provided"

      return { toolName: parsed.toolName, input, reason }
    } catch {
      // JSON parsing failed — log the raw text and default to DONE
      logRagEvent("agent_step", "Failed to parse tool decision — defaulting to DONE", {
        service: "AgentService",
      })

      return {
        toolName: "DONE",
        input: {},
        reason: `Parse error on: ${rawText.slice(0, 100)}`,
      }
    }
  }

  // ── extractCitationsFromHistory ───────────────────────────────────────
  // Extracts citation objects from RAG search results stored in tool history.
  // The rag.tool stores results as formatted text — we parse the source info.
  private extractCitationsFromHistory(toolCalls: ToolCall[]): Citation[] {
    const citations: Citation[] = []

    toolCalls
      .filter(tc => tc.toolName === "rag_search" && tc.success)
      .forEach(tc => {
        // Parse "[Result N] (source: filename, relevance: 0.0312)"
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
  // Converts a ToolDecision into a human-readable step description.
  // This is what appears in the frontend's step-by-step panel.
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
      let errorMsg = `Gemini API error: ${response.status} ${response.statusText}`

      try {
        const body = (await response.json()) as { error?: { message?: string } }
        if (body.error?.message) errorMsg += ` — ${body.error.message}`
      } catch {
        /* could not parse error body */
      }

      throw new Error(errorMsg)
    }

    return response.json() as Promise<GeminiResponse>
  }
}
