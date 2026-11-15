import type { ServerMessage } from "../../types/websocket.types"

export type AgentEventCallback = (message: ServerMessage) => void

export interface AgentRunParams {
  query: string
  userId: string
  sessionId: string
  signal?: AbortSignal
  onEvent?: AgentEventCallback
}

export interface ToolContext {
  signal?: AbortSignal
}
