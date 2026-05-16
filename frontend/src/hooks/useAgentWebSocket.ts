import { useState, useEffect, useRef, useCallback } from "react"
import { getAccessToken }       from "../utils/auth"
import type {
  AgentStatus,
  AgentStep,
  AgentResult,
  Citation
} from "../types"

// ── WebSocket Message Types (mirrors backend) ──────────────────────────────
// We duplicate just the types we need — no shared package needed.
interface WsConnectedMsg   { type: "connected"; sessionId: string }
interface WsAuthConfirmMsg { type: "auth_confirmed"; userId: string }
interface WsStatusMsg      { type: "status"; status: AgentStatus; message: string }
interface WsStepMsg        { type: "step"; step: AgentStep }
interface WsQualityMsg     { type: "quality"; score: number; shouldRetry: boolean; retryReason?: string }
interface WsCompleteMsg    { type: "complete"; result: AgentResult }
interface WsErrorMsg       { type: "error"; message: string; code?: string }
interface WsPongMsg        { type: "pong" }

type ServerMsg =
  | WsConnectedMsg
  | WsAuthConfirmMsg
  | WsStatusMsg
  | WsStepMsg
  | WsQualityMsg
  | WsCompleteMsg
  | WsErrorMsg
  | WsPongMsg

// ── Connection States ─────────────────────────────────────────────────────
export type WsConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "authenticated"
  | "error"

// ── Hook Return Type ──────────────────────────────────────────────────────
export interface UseAgentWebSocketReturn {
  connectionState:  WsConnectionState
  agentStatus:      AgentStatus
  currentMessage:   string          // human-readable status message
  steps:            AgentStep[]
  citations:        Citation[]
  finalAnswer:      string
  qualityScore:     number | null
  error:            string | null
  isRunning:        boolean
  startQuery:       (query: string) => void
  disconnect:       () => void
}

// ── WebSocket URL ─────────────────────────────────────────────────────────
const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined)
  ?? "ws://localhost:3001"

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// ── The Hook ─────────────────────────────────────────────────────────────
export function useAgentWebSocket(): UseAgentWebSocketReturn {
  const [connectionState, setConnectionState] = useState<WsConnectionState>("disconnected")
  const [agentStatus,     setAgentStatus]     = useState<AgentStatus>("idle")
  const [currentMessage,  setCurrentMessage]  = useState("ResearchBot ready")
  const [steps,           setSteps]           = useState<AgentStep[]>([])
  const [citations,       setCitations]       = useState<Citation[]>([])
  const [finalAnswer,     setFinalAnswer]     = useState("")
  const [qualityScore,    setQualityScore]    = useState<number | null>(null)
  const [error,           setError]           = useState<string | null>(null)
  const [isRunning,       setIsRunning]       = useState(false)

  const wsRef         = useRef<WebSocket | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Reset state for a new query ────────────────────────────────────────
  const resetQueryState = useCallback((): void => {
    setSteps([])
    setCitations([])
    setFinalAnswer("")
    setQualityScore(null)
    setError(null)
    setAgentStatus("idle")
    setCurrentMessage("Starting...")
  }, [])

  // ── Handle incoming WebSocket message ──────────────────────────────────
  const handleMessage = useCallback((event: MessageEvent): void => {
    try {
      const message = JSON.parse(event.data as string) as ServerMsg

      switch (message.type) {
        case "connected":
          setConnectionState("connected")
          // Immediately send auth message
          {
            const token = getAccessToken()
            if (token && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ type: "auth", token }))
            }
          }
          break

        case "auth_confirmed":
          setConnectionState("authenticated")
          setCurrentMessage("ResearchBot ready")
          break

        case "status":
          setAgentStatus(message.status)
          setCurrentMessage(message.message)
          break

        case "step":
          setSteps(prev => [...prev, message.step])
          break

        case "quality":
          setQualityScore(message.score)
          break

        case "complete":
          setFinalAnswer(message.result.finalAnswer)
          setCitations(message.result.citations)
          setAgentStatus("done")
          setCurrentMessage("Answer ready")
          setIsRunning(false)
          break

        case "error":
          setError(message.message)
          setAgentStatus("error")
          setCurrentMessage("Something went wrong")
          setIsRunning(false)
          break

        case "pong":
          // Heartbeat response — no state update needed
          break
      }
    } catch {
      // Ignore malformed messages
    }
  }, [])

  // ── Connect to WebSocket ───────────────────────────────────────────────
  const connect = useCallback((): void => {
    // Do not reconnect if already connected or connecting
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return
    }

    setConnectionState("connecting")

    const ws = new WebSocket(`${WS_URL}/ws/agent`)
    wsRef.current = ws

    ws.onopen = () => {
      // Connected — auth message is sent in the "connected" message handler
      // Start ping interval for heartbeat
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }))
        }
      }, 25_000)
    }

    ws.onmessage = handleMessage

    ws.onerror = () => {
      setConnectionState("error")
      setError("WebSocket connection failed. Falling back to HTTP mode.")
    }

    ws.onclose = () => {
      setConnectionState("disconnected")
      wsRef.current = null

      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current)
        pingIntervalRef.current = null
      }

      // Auto-reconnect after 3 seconds if not intentionally disconnected
      setTimeout(() => {
        if (wsRef.current === null) {
          // eslint-disable-next-line react-hooks/immutability
          connect()
        }
      }, 3000)
    }
  }, [handleMessage])

  // ── Disconnect ─────────────────────────────────────────────────────────
  const disconnect = useCallback((): void => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current)
      pingIntervalRef.current = null
    }

    if (wsRef.current) {
      wsRef.current.onclose = null   // prevent auto-reconnect
      wsRef.current.close()
      wsRef.current = null
    }

    setConnectionState("disconnected")
  }, [])

  // ── Start a query ──────────────────────────────────────────────────────
  const startQuery = useCallback((query: string): void => {
    if (!query.trim()) return

    // Must be authenticated
    if (connectionState !== "authenticated") {
      setError("WebSocket not ready. Please wait a moment and try again.")
      return
    }

    if (isRunning) {
      setError("A query is already running. Please wait.")
      return
    }

    resetQueryState()
    setIsRunning(true)

    const sessionId = generateSessionId()

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type:      "start",
        query:     query.trim(),
        sessionId
      }))
    } else {
      setError("WebSocket disconnected. Reconnecting...")
      setIsRunning(false)
      connect()
    }
  }, [connectionState, isRunning, resetQueryState, connect])

  // ── Connect on mount, disconnect on unmount ────────────────────────────
  useEffect(() => {
    connect()
    return () => {
      disconnect()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // NOTE: connect and disconnect are stable (useCallback) but we only want
  // to run this effect once on mount. Disabling the dependency warning is
  // intentional here.

  return {
    connectionState,
    agentStatus,
    currentMessage,
    steps,
    citations,
    finalAnswer,
    qualityScore,
    error,
    isRunning,
    startQuery,
    disconnect
  }
}