// backend/src/__tests__/auth.register.test.ts
//
// Task 2.5 (D20): IP rate limits on /auth/login and /auth/register, and the
// ALLOW_REGISTRATION switch (403 "Registration is closed" when false).
//
// Requests are sent with X-Forwarded-For + trust proxy (mirroring app.ts) so
// req.ip is deterministic. Invalid bodies stop in the validators, so the
// controller/service/Prisma layer is never reached.

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

// ── Modules under test (required AFTER the mocks are defined) ─────────────
const authRoutes = require("../routes/auth.routes").default as import("express").Router
const { errorMiddleware } =
  require("../middleware/error.middleware") as typeof import("../middleware/error.middleware")
const { LOGIN_LIMIT, REGISTER_LIMIT } =
  require("../middleware/rate-limit.middleware") as typeof import("../middleware/rate-limit.middleware")

const ORIGINAL_ENV_REGISTRATION = process.env.ALLOW_REGISTRATION

describe("auth IP rate limits and ALLOW_REGISTRATION (2.5)", () => {
  let server: import("http").Server
  let baseUrl: string

  beforeAll(async () => {
    const express = require("express") as typeof import("express")
    const app = express()
    // Mirror app.ts: Caddy is the only proxy, so trust one hop and the
    // X-Forwarded-For header becomes req.ip.
    app.set("trust proxy", 1)
    app.use(express.json())
    app.use("/auth", authRoutes)
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
    if (ORIGINAL_ENV_REGISTRATION === undefined) {
      delete process.env.ALLOW_REGISTRATION
    } else {
      process.env.ALLOW_REGISTRATION = ORIGINAL_ENV_REGISTRATION
    }
  })

  beforeEach(() => {
    mockRedisStore.clear()
    mockTtlStore.clear()
    jest.clearAllMocks()
    delete process.env.ALLOW_REGISTRATION
  })

  const post = async (path: string, body: unknown, forwardedFor: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
      body: JSON.stringify(body),
    })

  // Invalid on purpose: stops in validateRegister/validateLogin (400), so the
  // controller (and Prisma) is never reached.
  const INVALID_BODY = { email: "not-an-email" }

  describe("ALLOW_REGISTRATION switch", () => {
    it('returns 403 { error: "Registration is closed" } when set to false', async () => {
      process.env.ALLOW_REGISTRATION = "false"

      const res = await post("/auth/register", INVALID_BODY, "203.0.113.10")
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "Registration is closed" })
    })

    it("returns 403 for any body when closed (gate runs before validation)", async () => {
      process.env.ALLOW_REGISTRATION = "false"

      const res = await post(
        "/auth/register",
        { email: "a@b.co", password: "longenough" },
        "203.0.113.11"
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "Registration is closed" })
    })

    it("stays open by default (validation 400, not 403)", async () => {
      const res = await post("/auth/register", INVALID_BODY, "203.0.113.12")
      expect(res.status).toBe(400)
    })
  })

  describe("REGISTER_LIMIT (5 per hour per IP)", () => {
    it("allows 5 attempts per IP then returns 429", async () => {
      for (let i = 0; i < REGISTER_LIMIT.max; i++) {
        const res = await post("/auth/register", INVALID_BODY, "198.51.100.20")
        expect(res.status).toBe(400)
      }

      const res = await post("/auth/register", INVALID_BODY, "198.51.100.20")
      expect(res.status).toBe(429)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe(REGISTER_LIMIT.message)
      expect(mockRedisStore.get("rl:register:ip:198.51.100.20")).toBe(REGISTER_LIMIT.max + 1)
    })

    it("keeps a different IP unaffected", async () => {
      for (let i = 0; i < REGISTER_LIMIT.max; i++) {
        await post("/auth/register", INVALID_BODY, "198.51.100.21")
      }

      const res = await post("/auth/register", INVALID_BODY, "198.51.100.22")
      expect(res.status).toBe(400)
    })
  })

  describe("LOGIN_LIMIT (10 per 15 min per IP)", () => {
    it("allows 10 attempts per IP then returns 429", async () => {
      for (let i = 0; i < LOGIN_LIMIT.max; i++) {
        const res = await post("/auth/login", INVALID_BODY, "203.0.113.30")
        expect(res.status).toBe(400)
      }

      const res = await post("/auth/login", INVALID_BODY, "203.0.113.30")
      expect(res.status).toBe(429)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe(LOGIN_LIMIT.message)
      expect(mockRedisStore.get("rl:login:ip:203.0.113.30")).toBe(LOGIN_LIMIT.max + 1)
    })
  })
})

export {}
