import { useState, useEffect, useRef, useCallback } from "react"
import { getAccessToken }       from "../utils/auth"
import { refreshAccessToken, logout } from "../utils/api"
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
interface WsErrorMsg      { type: "error"; message: string; code?: string }
interface WsVoiceErrorMsg { type: "voice_error"; sessionId: string; code?: string; message: string }
interface WsPongMsg       { type: "pong" }

type ServerMsg =
  | WsConnectedMsg
  | WsAuthConfirmMsg
  | WsStatusMsg
  | WsStepMsg
  | WsQualityMsg
  | WsCompleteMsg
  | WsErrorMsg
  | WsVoiceErrorMsg
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
  qualityScore:   number | null
  error:          string | null
  /** Last voice-layer refusal (quota, session, budget…) — null when none. */
  voiceError:     string | null
  isRunning:      boolean
  startQuery:     (query: string) => void
  disconnect:     () => void
  /** Day 4: open a voice utterance (re-uses the session id across turns). */
  voiceStart:     () => void
  /** Day 4: close the utterance — the voice session survives for 10 min. */
  voiceEnd:       () => void
  /** Day 4: one binary PCM16 frame (≤ 4096 bytes) to the server. */
  sendVoiceFrame: (frame: Uint8Array<ArrayBuffer>) => void
}

// ── WebSocket URL ─────────────────────────────────────────────────────────
// Same origin by default (Vite proxies /ws in dev, Caddy in production).
// Set VITE_WS_URL only for unusual split-origin setups.
const WS_URL =
  import.meta.env.VITE_WS_URL ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`

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
  const [voiceError,      setVoiceError]      = useState<string | null>(null)
  const [isRunning,       setIsRunning]       = useState(false)

  const wsRef         = useRef<WebSocket | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // One token refresh per expiry (task 3.6): set on a 4001 close, cleared
  // again once the server confirms authentication with the new token.
  const refreshAttemptedRef = useRef(false)
  // Day 4: the voice session id survives voice_end (10-minute server
  // session) but dies with the socket — the server keeps it per-connection.
  const voiceSessionIdRef = useRef<string | null>(null)

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
          refreshAttemptedRef.current = false
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
          if (message.code === "TOKEN_EXPIRED") {
            // The server closes with 4001 right after this message — onclose
            // refreshes the token and reconnects (task 3.6).
            setCurrentMessage("Session expired — reconnecting…")
          } else {
            // RATE_LIMITED / CAPACITY_REACHED and friends stay visible in
            // the chat as readable messages.
            setError(message.message)
            setAgentStatus("error")
            setCurrentMessage("Something went wrong")
          }
          setIsRunning(false)
          break

        case "voice_error":
          // Day 4: quota/session/budget refusals from the voice layer.
          // Kept separate from `error` so the UI can stop the mic without
          // mistaking a voice refusal for a failed agent run.
          setVoiceError(message.message)
          if (message.code === "TOKEN_EXPIRED") {
            setCurrentMessage("Session expired — reconnecting…")
          } else {
            setError(message.message)
            setCurrentMessage("Voice error")
          }
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

    ws.onclose = (event) => {
      setConnectionState("disconnected")
      wsRef.current = null
      // Day 4: the server keeps the voice session per-connection — a new
      // socket must start a fresh one (fresh quota gates apply there too).
      voiceSessionIdRef.current = null

      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current)
        pingIntervalRef.current = null
      }

      // F5: the server aborts any in-flight run when this socket closes
      // (agent.ws.handler.ts "close" listener), so no "complete"/"error"
      // message is coming for it. Reset the run flags here — otherwise
      // startQuery stays blocked with "A query is already running" until
      // a full page reload. Done/error states are kept: they describe a
      // finished run, not a running one.
      setIsRunning(false)
      setAgentStatus(prev => (prev === "done" || prev === "error" ? prev : "idle"))

      // 4001 = token expired (or auth never completed). Refresh once, then
      // reconnect with the new token; if the refresh fails, log out.
      if (event.code === 4001 && !refreshAttemptedRef.current) {
        refreshAttemptedRef.current = true
        void refreshAccessToken().then(accessToken => {
          if (accessToken) {
            // eslint-disable-next-line react-hooks/immutability
            connect()
          } else {
            logout()
          }
        })
        return
      }

      // Auto-reconnect after 3 seconds if not intentionally disconnected
      setTimeout(() => {
        if (wsRef.current === null) {
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
      if (wsRef.current.readyState === WebSocket.OPEN) { wsRef.current.close() }
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

  // ── Voice layer (Day 4): utterance control + binary frames ─────────────
  const voiceStart = useCallback((): void => {
    if (connectionState !== "authenticated") {
      setError("WebSocket not ready. Please wait a moment and try again.")
      return
    }
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return
    if (voiceSessionIdRef.current === null) {
      voiceSessionIdRef.current = generateSessionId()
    }
    setVoiceError(null)
    ws.send(JSON.stringify({ type: "voice_start", sessionId: voiceSessionIdRef.current }))
  }, [connectionState])

  const voiceEnd = useCallback((): void => {
    const ws = wsRef.current
    const sessionId = voiceSessionIdRef.current
    if (ws?.readyState !== WebSocket.OPEN || sessionId === null) return
    ws.send(JSON.stringify({ type: "voice_end", sessionId }))
  }, [])

  const sendVoiceFrame = useCallback((frame: Uint8Array<ArrayBuffer>): void => {
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(frame)
  }, [])

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
    voiceError,
    isRunning,
    startQuery,
    disconnect,
    voiceStart,
    voiceEnd,
    sendVoiceFrame
  }
}