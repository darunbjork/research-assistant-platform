// backend/src/__tests__/ws.hardening.test.ts
//
// Task 2.8 items 3-5 (handler level):
//   3. auth timeout — no auth within 10s ⇒ close(4001)
//   4. query length  — start with query.length > 2000 ⇒ INVALID_QUERY
//   5. token expiry  — exp passed since auth ⇒ TOKEN_EXPIRED + close(4001)

import type WebSocket from "ws"

// ── Mock Redis (rate limit + global budget pipelines) ─────────────────────
const mockRedisStore = new Map<string, number>()
const mockTtlStore = new Map<string, number>()

const mockRedis = {
  multi: jest.fn(() => {
    let incCount = 0
    let expireResult = 0
    let ttlResult = -1
    const pipeline: {
      incr: jest.Mock
      incrby: jest.Mock
      expire: jest.Mock
      ttl: jest.Mock
      exec: jest.Mock
    } = {
      incr: jest.fn((key: string): typeof pipeline => {
        const next = (mockRedisStore.get(key) ?? 0) + 1
        mockRedisStore.set(key, next)
        incCount = next
        return pipeline
      }),
      incrby: jest.fn((key: string, by: number): typeof pipeline => {
        const next = (mockRedisStore.get(key) ?? 0) + by
        mockRedisStore.set(key, next)
        incCount = next
        return pipeline
      }),
      expire: jest.fn((key: string, seconds: number, nx?: string): typeof pipeline => {
        if (nx === "NX" && mockTtlStore.has(key)) {
          expireResult = 0
        } else {
          mockTtlStore.set(key, seconds)
          expireResult = 1
        }
        return pipeline
      }),
      ttl: jest.fn((key: string): typeof pipeline => {
        ttlResult = mockTtlStore.get(key) ?? -1
        return pipeline
      }),
      exec: jest.fn(
        async (): Promise<Array<[null, number]>> => [
          [null, incCount],
          [null, expireResult],
          [null, ttlResult],
        ]
      ),
    }
    return pipeline
  }),
}

jest.mock("../utils/redis", () => ({ redis: mockRedis, default: mockRedis }))

// ── Controllable JWT verification ─────────────────────────────────────────
// `exp` is read per auth so individual tests can place it in the past.
let mockExp: number | undefined

jest.mock("../utils/jwt.utils", () => ({
  verifyAccessToken: jest.fn(() => ({
    userId: "user-ws",
    email: "ws@test.local",
    role: "USER" as const,
    exp: mockExp ?? Math.floor(Date.now() / 1000) + 3600,
  })),
}))

// ── Streaming agent mocked so no Gemini call can happen ───────────────────
const mockStreamingRun = jest.fn().mockResolvedValue(undefined)

jest.mock("../services/streaming.agent.service", () => ({
  StreamingAgentService: class {
    run = (...args: unknown[]): Promise<unknown> => mockStreamingRun(...args)
  },
}))

// ── Modules under test (required AFTER the mocks are defined) ─────────────
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-key-not-a-real-secret"

const { AgentWsHandler } =
  require("../websocket/agent.ws.handler") as typeof import("../websocket/agent.ws.handler")

// ── Helpers ───────────────────────────────────────────────────────────────

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

type Listener = (...args: unknown[]) => void

class FakeWebSocket {
  readyState = 1 // OPEN
  readonly sent: string[] = []
  readonly close = jest.fn()
  private readonly listeners = new Map<string, Listener[]>()

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args)
    }
  }

  send(data: string): void {
    this.sent.push(data)
  }
}

interface ParsedMessage {
  type: string
  code?: string
  sessionId?: string
  message?: string
}

describe("WebSocket handler hardening (2.8)", () => {
  beforeEach(() => {
    mockRedisStore.clear()
    mockTtlStore.clear()
    jest.clearAllMocks()
    mockExp = undefined
  })

  function makeAuthenticatedHandler(): FakeWebSocket {
    const ws = new FakeWebSocket()
    new AgentWsHandler(ws as unknown as WebSocket)
    ws.emit("message", JSON.stringify({ type: "auth", token: "test-token" }))
    return ws
  }

  const parsed = (ws: FakeWebSocket): ParsedMessage[] =>
    ws.sent.map(raw => JSON.parse(raw) as ParsedMessage)

  // ── Item 3: auth timeout ───────────────────────────────────────────────
  describe("auth timeout", () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it("closes with 4001 when no auth arrives within 10 seconds", () => {
      const ws = new FakeWebSocket()
      new AgentWsHandler(ws as unknown as WebSocket)

      jest.advanceTimersByTime(10_000)

      expect(ws.close).toHaveBeenCalledWith(4001, "authentication timeout")
    })

    it("does not close after a successful auth", () => {
      const ws = new FakeWebSocket()
      new AgentWsHandler(ws as unknown as WebSocket)

      ws.emit("message", JSON.stringify({ type: "auth", token: "test-token" }))
      jest.advanceTimersByTime(10_000)

      expect(ws.close).not.toHaveBeenCalled()
      expect(parsed(ws).some(m => m.type === "auth_confirmed")).toBe(true)
    })

    it("does not fire early (stays open before the 10s window)", () => {
      const ws = new FakeWebSocket()
      new AgentWsHandler(ws as unknown as WebSocket)

      jest.advanceTimersByTime(9_999)

      expect(ws.close).not.toHaveBeenCalled()
    })
  })

  // ── Item 5: token expiry ───────────────────────────────────────────────
  describe("token expiry", () => {
    it("sends TOKEN_EXPIRED and closes with 4001 when exp has passed", async () => {
      mockExp = Math.floor(Date.now() / 1000) - 60 // expired a minute ago
      const ws = makeAuthenticatedHandler()
      await flush()

      ws.emit("message", JSON.stringify({ type: "start", query: "hello", sessionId: "s1" }))
      await flush()

      const errors = parsed(ws).filter(m => m.type === "error")
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: "TOKEN_EXPIRED", sessionId: "s1" })
      expect(ws.close).toHaveBeenCalledWith(4001, "token expired")
      expect(mockStreamingRun).not.toHaveBeenCalled()
    })

    it("runs normally while the token is still valid", async () => {
      mockExp = Math.floor(Date.now() / 1000) + 600 // valid for 10 more minutes
      const ws = makeAuthenticatedHandler()
      await flush()

      ws.emit("message", JSON.stringify({ type: "start", query: "hello", sessionId: "s1" }))
      await flush()

      expect(ws.close).not.toHaveBeenCalled()
      expect(mockStreamingRun).toHaveBeenCalledTimes(1)
    })
  })

  // ── Item 4: query length ───────────────────────────────────────────────
  describe("query length", () => {
    it("rejects a start with query.length > 2000 as INVALID_QUERY", async () => {
      const ws = makeAuthenticatedHandler()
      await flush()

      ws.emit(
        "message",
        JSON.stringify({ type: "start", query: "a".repeat(2001), sessionId: "s1" })
      )
      await flush()

      const errors = parsed(ws).filter(m => m.type === "error")
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: "INVALID_QUERY", sessionId: "s1" })
      expect(errors[0]?.message).toContain("2000")
      expect(mockStreamingRun).not.toHaveBeenCalled()
    })

    it("accepts a start with query.length exactly 2000", async () => {
      const ws = makeAuthenticatedHandler()
      await flush()

      ws.emit(
        "message",
        JSON.stringify({ type: "start", query: "a".repeat(2000), sessionId: "s1" })
      )
      await flush()

      expect(mockStreamingRun).toHaveBeenCalledTimes(1)
      expect(parsed(ws).filter(m => m.type === "error")).toHaveLength(0)
    })
  })
})
