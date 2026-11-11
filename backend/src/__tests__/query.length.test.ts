// backend/src/__tests__/query.length.test.ts
//
// Task 2.8 item 4 (HTTP side): query.length > 2000 must be a 400 on the
// agent chat and both RAG query endpoints — the same cap the WebSocket
// handler enforces with INVALID_QUERY.
//
// Only the rejection path is exercised: the length check runs before the
// budget/RAG pipeline, so no Redis, Prisma or Gemini call can happen.

// ── Mock Redis (route-level rate limiters) ────────────────────────────────
const mockRedisStore = new Map<string, number>()
const mockTtlStore = new Map<string, number>()

const mockRedis = {
  multi: jest.fn(() => {
    let incCount = 0
    let expireResult = 0
    let ttlResult = -1
    const pipeline: {
      incr: jest.Mock
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

// ── Fake auth so the routes are reachable without a JWT ───────────────────
jest.mock("../middleware/auth.middleware", () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void): void => {
    req.user = { userId: "user-1", email: "t@test.local", role: "USER" }
    next()
  },
}))

// ── Routes under test (required AFTER the mocks are defined) ──────────────
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-key-not-a-real-secret"

const agentRoutes = (require("../routes/agent.routes") as { default: import("express").Router })
  .default
const ragRoutes = (require("../routes/rag.routes") as { default: import("express").Router }).default
const { errorMiddleware } =
  require("../middleware/error.middleware") as typeof import("../middleware/error.middleware")

const ORIGINAL_ENV_KEY = process.env.GEMINI_API_KEY

describe("HTTP query length cap (2.8)", () => {
  let server: import("http").Server
  let baseUrl: string

  beforeAll(async () => {
    const express = require("express") as typeof import("express")
    const app = express()
    app.use(express.json())
    app.use("/agent", agentRoutes)
    app.use("/rag", ragRoutes)
    app.use(errorMiddleware)

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
    if (ORIGINAL_ENV_KEY === undefined) {
      delete process.env.GEMINI_API_KEY
    } else {
      process.env.GEMINI_API_KEY = ORIGINAL_ENV_KEY
    }
  })

  beforeEach(() => {
    mockRedisStore.clear()
    mockTtlStore.clear()
    jest.clearAllMocks()
  })

  const post = async (path: string, query: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    })

  const OVER_LIMIT = "a".repeat(2001)

  it("POST /agent/chat returns 400 for a query over 2000 chars", async () => {
    const res = await post("/agent/chat", OVER_LIMIT)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain("2000")
  })

  it("POST /rag/query returns 400 for a query over 2000 chars", async () => {
    const res = await post("/rag/query", OVER_LIMIT)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain("2000")
  })

  it("POST /rag/query-with-rerank returns 400 for a query over 2000 chars", async () => {
    const res = await post("/rag/query-with-rerank", OVER_LIMIT)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain("2000")
  })
})

export {}
