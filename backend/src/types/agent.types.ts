// backend/src/types/agent.types.ts
// All types for the AI agent system.
// The agent state is a snapshot of everything the agent knows
// at any point in the ReAct loop — used for logging, debugging,
// and eventually persisting to the AgentSession table.

import type { HybridSearchResult, Citation } from "./retrieval.types"

// ── Agent State ───────────────────────────────────────────────────────────
// The complete state of one agent session.
// Grows with each iteration of the ReAct loop.

export type AgentStatus =
  | "idle"
  | "thinking" // LLM is deciding what tool to call next
  | "searching" // rag_search tool is executing
  | "calculating" // calculator tool is executing
  | "web_searching" // web_search tool is executing
  | "generating" // building the final answer
  | "evaluating" // self-assessing answer quality (Day 15)
  | "done"
  | "error"

export type TaskType = "rag_search" | "web_search" | "math" | "general"

export interface AgentState {
  sessionId: string
  userQuery: string
  taskType: TaskType
  searchResults: HybridSearchResult[]
  toolCallHistory: ToolCall[]
  draftAnswer: string
  finalAnswer: string
  citations: Citation[]
  iterationCount: number
  isComplete: boolean
  qualityScore: number // 0-1, self-evaluated (Day 15)
  status: AgentStatus
  error?: string // set if status === "error"
  startedAt: Date
  completedAt?: Date
}

// ── Tool Types ────────────────────────────────────────────────────────────

// One tool call made by the agent during a ReAct iteration
export interface ToolCall {
  toolName: string
  input: Record<string, string> // what the agent passed to the tool
  output: string // what the tool returned
  durationMs: number
  timestamp: Date
  success: boolean
  error?: string
}

// The LLM's decision about what to do next
export interface ToolDecision {
  toolName: string // "rag_search" | "calculator" | "DONE"
  input: Record<string, string> // the parameters for the tool
  reason: string // the agent's reasoning (for logs/debug)
}

// ── Tool Interface ────────────────────────────────────────────────────────
// Every tool in the registry must implement this interface.

export interface AgentTool {
  name: string
  description: string // shown to the LLM — quality of this description
  // directly affects how well the agent chooses tools
  execute: (input: Record<string, string>) => Promise<string>
}

// ── Agent Step (for frontend display) ─────────────────────────────────────
// A human-readable step shown in the UI while the agent is working.
// Day 16 (WebSocket) will stream these in real-time.

export interface AgentStep {
  stepNumber: number
  description: string // "Searching for Q3 revenue figures..."
  toolUsed?: string
  durationMs: number
  timestamp: Date
}

// ── Agent Result (what the controller returns) ────────────────────────────
export interface AgentResult {
  sessionId: string
  finalAnswer: string
  citations: Citation[]
  steps: AgentStep[]
  iterationCount: number
  status: AgentStatus
  tokensUsed: number
  durationMs: number
}
