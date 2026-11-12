// frontend/src/hooks/useAgentWebSocket.test.ts
// Regression test for F5: a socket close during a running query must reset
// isRunning. The server aborts the run when the socket closes, so no
// "complete" or "error" message will ever arrive to reset it — without this
// fix startQuery stays blocked with "A query is already running" until the
// user reloads the page.

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAgentWebSocket, type UseAgentWebSocketReturn } from "./useAgentWebSocket"
import { saveTokens } from "../utils/auth"

// ── Controllable WebSocket double ──────────────────────────────────────────
// The hook assigns ws.onopen/onmessage/onclose (property slots, not
// addEventListener), so the double only needs those slots plus helpers to
// fire them. Static constants mirror the DOM WebSocket API the hook reads
// (WebSocket.OPEN etc. after vi.stubGlobal).
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  static instances: MockWebSocket[] = []

  readyState: number = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []
  url: string

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }

  /** Server accepted the upgrade — readyState goes OPEN and onopen fires. */
  fireOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  /** A JSON message arriving from the server. */
  fireServerMessage(message: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }))
  }

  /** Socket closed; `code` is exposed on the CloseEvent like the browser does. */
  fireClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED
    const event = new Event("close") as CloseEvent
    Object.defineProperty(event, "code", { value: code })
    this.onclose?.(event)
  }
}

function latestSocket(): MockWebSocket {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  if (ws === undefined) {
    throw new Error("hook did not open a WebSocket")
  }
  return ws
}

/** Connect, authenticate, then start one query. Returns live hook state. */
function startAuthenticatedQuery(): {
  result: { current: UseAgentWebSocketReturn }
  ws: MockWebSocket
} {
  const rendered = renderHook(() => useAgentWebSocket())
  const ws = latestSocket()

  act(() => ws.fireOpen())
  act(() => ws.fireServerMessage({ type: "connected", sessionId: "pending-auth" }))
  act(() => ws.fireServerMessage({ type: "auth_confirmed", userId: "user-1" }))
  expect(rendered.result.current.connectionState).toBe("authenticated")

  act(() => rendered.result.current.startQuery("Who kept the SurDal lighthouse in 1847?"))
  expect(rendered.result.current.isRunning).toBe(true)

  return { result: rendered.result, ws }
}

describe("useAgentWebSocket — F5 run-state reset", () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    // The hook schedules a 25s heartbeat and a 3s reconnect — keep both
    // fully under test control instead of leaking real timers.
    vi.useFakeTimers()
    vi.stubGlobal("WebSocket", MockWebSocket)
    saveTokens("test-access-token", "test-refresh-token")
  })

  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("resets isRunning when the socket closes mid-query", () => {
    const { result, ws } = startAuthenticatedQuery()

    // Abnormal closure: no server messages are coming for this run.
    act(() => ws.fireClose(1006))

    expect(result.current.isRunning).toBe(false)
    expect(result.current.connectionState).toBe("disconnected")
  })

  it("allows a new query after reconnecting following a mid-run close", () => {
    const { result, ws } = startAuthenticatedQuery()
    act(() => ws.fireClose(1006))

    // Auto-reconnect fires after 3s (fake timers).
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    const reconnected = latestSocket()
    expect(reconnected).not.toBe(ws)

    act(() => reconnected.fireOpen())
    act(() => reconnected.fireServerMessage({ type: "connected", sessionId: "pending-auth" }))
    act(() => reconnected.fireServerMessage({ type: "auth_confirmed", userId: "user-1" }))

    // F5 symptom: before the fix this set error "A query is already
    // running" and sent nothing. Now the query must go through.
    act(() => result.current.startQuery("Second question after reconnect"))

    expect(result.current.error).toBeNull()
    expect(result.current.isRunning).toBe(true)
    expect(reconnected.sent.some(payload => payload.includes('"type":"start"'))).toBe(true)
  })
})
