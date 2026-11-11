// backend/src/__tests__/agent.ratelimit.test.ts
//
// D6: AGENT_LIMIT (30 per hour) must be enforced on BOTH entry points:
//   - HTTP  POST /agent/chat
//   - WebSocket "start" messages
// The 31st request inside the window is rejected in both cases.
//
// Redis is mocked exactly the way rate-limit.middleware.test.ts does it —
// consumeRateLimit() drives multi().incr().expire(NX).ttl().exec().

import type WebSocket from "ws"

// ── Mock Redis (chainable pipeline with EXPIRE NX semantics) ──────────────
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
      // consumeGlobalBudget() uses INCRBY (global daily budget), not INCR.
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
  get: jest.fn(async (key: string): Promise<string | null> => {
    const val = mockRedisStore.get(key)
    return val !== undefined ? String(val) : null
  }),
  ttl: jest.fn(async (key: string): Promise<number> => mockTtlStore.get(key) ?? -1),
  del: jest.fn(async (): Promise<number> => 0),
}

jest.mock("../utils/redis", () => ({ redis: mockRedis, default: mockRedis }))

// env is parsed once at import (task 3.1) — mock it with a mutable copy so
// the global daily budget cap can be flipped per test.
jest.mock("../config/env", () => {
  const actual = jest.requireActual("../config/env") as typeof import("../config/env")
  return { ...actual, env: { ...actual.env } }
})

// ── HTTP: fake auth + fake agent so only the limiter is under test ────────
jest.mock("../middleware/auth.middleware", () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void): void => {
    req.user = { userId: "user-http", role: "USER" }
    next()
  },
}))

jest.mock("../controllers/agent.controller", () => ({
  AgentController: class {
    chat = (
      _req: unknown,
      res: { status(code: number): { json(body: unknown): unknown } },
      _next: unknown
    ): void => {
      res.status(200).json({ success: true })
    }
  },
}))

// ── WebSocket: fake JWT + no-op streaming agent ───────────────────────────
jest.mock("../utils/jwt.utils", () => ({
  verifyAccessToken: jest.fn(() => ({
    userId: "user-ws",
    email: "ws@test.local",
    role: "USER",
  })),
}))

const mockStreamingRun = jest.fn().mockResolvedValue(undefined)

jest.mock("../services/streaming.agent.service", () => ({
  StreamingAgentService: class {
    run = (...args: unknown[]): Promise<unknown> => mockStreamingRun(...args)
  },
}))

// ── Modules under test (required AFTER the mocks are defined) ─────────────
// agent.ws.handler builds its services at module load and the service
// constructors demand a non-empty API key — supply a placeholder (Gemini is
// never actually called here; the streaming agent is mocked).
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-key-not-a-real-secret"

const { AGENT_LIMIT } =
  require("../middleware/rate-limit.middleware") as typeof import("../middleware/rate-limit.middleware")
const agentRoutes = require("../routes/agent.routes").default as import("express").Router
const { AgentWsHandler } =
  require("../websocket/agent.ws.handler") as typeof import("../websocket/agent.ws.handler")
const { env } = require("../config/env") as typeof import("../config/env")

// ── Helpers ───────────────────────────────────────────────────────────────

function flush(): Promise<void> {
  // handleMessage() is fire-and-forget (`void this.handleMessage(...)`).
  // One macrotask lets every pending microtask (mocked promises) settle.
  return new Promise(resolve => setImmediate(resolve))
}

type Listener = (...args: unknown[]) => void

class FakeWebSocket {
  readyState = 1 // OPEN
  readonly sent: string[] = []
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe("AGENT_LIMIT enforcement (D6)", () => {
  beforeEach(() => {
    mockRedisStore.clear()
    mockTtlStore.clear()
    jest.clearAllMocks()
  })

  describe("HTTP POST /agent/chat", () => {
    let server: import("http").Server
    let baseUrl: string

    beforeAll(async () => {
      const express = require("express") as typeof import("express")
      const app = express()
      app.use(express.json())
      app.use("/agent", agentRoutes)

      await new Promise<void>(resolve => {
        server = app.listen(0, () => resolve())
      })
      const address = server.address()
      if (address === null || typeof address === "string") {
        throw new Error("Could not determine test server port")
      }
      baseUrl = `http://127.0.0.1:${address.port}`
    })

    afterAll(async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    })

    it("allows 30 chats in the window and returns 429 for the 31st", async () => {
      const postChat = async (query: string): Promise<Response> =>
        fetch(`${baseUrl}/agent/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        })

      for (let i = 1; i <= AGENT_LIMIT.max; i++) {
        const res = await postChat(`question ${i}`)
        expect(res.status).toBe(200)
      }

      const blocked = await postChat("question 31")
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0")
      expect(blocked.headers.get("Retry-After")).not.toBeNull()

      const body = (await blocked.json()) as Record<string, unknown>
      expect(body).toMatchObject({
        success: false,
        error: AGENT_LIMIT.message,
        limit: AGENT_LIMIT.max,
        windowMs: AGENT_LIMIT.windowMs,
      })
    })
  })

  describe("WebSocket start", () => {
    it("allows 30 starts and rejects the 31st with RATE_LIMITED", async () => {
      const fakeWs = new FakeWebSocket()
      const handler = new AgentWsHandler(fakeWs as unknown as WebSocket)

      // Authenticate
      fakeWs.emit("message", JSON.stringify({ type: "auth", token: "test-token" }))
      await flush()

      const parsed = (): ParsedMessage[] => fakeWs.sent.map(raw => JSON.parse(raw) as ParsedMessage)
      expect(parsed().some(m => m.type === "auth_confirmed")).toBe(true)

      // 30 successful starts
      for (let i = 1; i <= AGENT_LIMIT.max; i++) {
        fakeWs.emit(
          "message",
          JSON.stringify({ type: "start", query: `question ${i}`, sessionId: `s${i}` })
        )
        await flush()
      }
      expect(mockStreamingRun).toHaveBeenCalledTimes(AGENT_LIMIT.max)

      // 31st start — rejected before the agent runs
      fakeWs.emit(
        "message",
        JSON.stringify({ type: "start", query: "question 31", sessionId: "s31" })
      )
      await flush()

      const errors = parsed().filter(m => m.type === "error")
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({
        code: "RATE_LIMITED",
        sessionId: "s31",
        message: AGENT_LIMIT.message,
      })
      expect(mockStreamingRun).toHaveBeenCalledTimes(AGENT_LIMIT.max)

      // Handler instance is still usable (not marked running)
      expect(handler).toBeDefined()
    })
  })

  describe("global daily capacity (2.4)", () => {
    afterEach(() => {
      env.GLOBAL_DAILY_LLM_CALLS_MAX = 2000
    })

    it("rejects a start with CAPACITY_REACHED when the global budget is exhausted", async () => {
      // A single unit of headroom: the first start costs 5 ⇒ over the max,
      // while the per-user AGENT_LIMIT (30/h) still has room.
      env.GLOBAL_DAILY_LLM_CALLS_MAX = 1

      const fakeWs = new FakeWebSocket()
      new AgentWsHandler(fakeWs as unknown as WebSocket)

      fakeWs.emit("message", JSON.stringify({ type: "auth", token: "test-token" }))
      await flush()

      fakeWs.emit("message", JSON.stringify({ type: "start", query: "hello", sessionId: "s1" }))
      await flush()

      expect(mockStreamingRun).not.toHaveBeenCalled()
      const parsed = (): ParsedMessage[] => fakeWs.sent.map(raw => JSON.parse(raw) as ParsedMessage)
      const errors = parsed().filter(m => m.type === "error")
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({
        code: "CAPACITY_REACHED",
        sessionId: "s1",
        message: "Daily capacity reached, try again tomorrow",
      })
    })
  })
})
