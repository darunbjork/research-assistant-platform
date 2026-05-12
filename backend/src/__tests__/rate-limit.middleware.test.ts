import type { Request, Response } from "express"
import type { RateLimitConfig } from "../middleware/rate-limit.middleware"

// ── Mock Redis ────────────────────────────────────────────────────────────
// We mock the entire redis module so the rate limiter uses our fake Redis
const mockRedisStore = new Map<string, number>()
const mockTtlStore = new Map<string, number>()

const mockRedis = {
  incr: jest.fn(async (key: string): Promise<number> => {
    const current = mockRedisStore.get(key) ?? 0
    const next = current + 1
    mockRedisStore.set(key, next)
    return next
  }),
  expire: jest.fn(async (key: string, ttl: number): Promise<void> => {
    mockTtlStore.set(key, ttl)
  }),
  ttl: jest.fn(async (key: string): Promise<number> => {
    return mockTtlStore.get(key) ?? 3600
  }),
  get: jest.fn(async (key: string): Promise<string | null> => {
    const val = mockRedisStore.get(key)
    return val !== undefined ? String(val) : null
  }),
  del: jest.fn(async (key: string): Promise<number> => {
    const existed = mockRedisStore.has(key)
    mockRedisStore.delete(key)
    mockTtlStore.delete(key)
    return existed ? 1 : 0
  }),
}

// Mock the redis module before importing the middleware
jest.mock("../utils/redis", () => ({
  redis: mockRedis,
}))

// Now import the middleware (it will use our mocked Redis)
const { createRateLimiter } =
  require("../middleware/rate-limit.middleware") as typeof import("../middleware/rate-limit.middleware")

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeRequest(userId: string): Partial<Request> {
  return {
    user: { userId, email: "test@test.com", role: "USER" },
  }
}

function makeResponse() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, unknown>,
    setHeader: function (name: string, value: unknown) {
      this.headers[name] = value
      return this
    },
    status: function (code: number) {
      this.statusCode = code
      return this
    },
    json: function (body: unknown) {
      this.body = body
      return this
    },
  }
  return res
}

function makeNext(): jest.Mock {
  return jest.fn()
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("createRateLimiter()", () => {
  const TEST_CONFIG: RateLimitConfig = {
    windowMs: 60_000, // 1 minute
    max: 3, // very low for testing
    message: "Rate limit exceeded",
    keyPrefix: "test",
  }

  beforeEach(() => {
    // Clear the mock Redis store between tests
    mockRedisStore.clear()
    mockTtlStore.clear()
    jest.clearAllMocks()
  })

  // ── Allows requests under the limit ────────────────────────────────────
  describe("requests under the limit", () => {
    it("calls next() for the first request", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const req = makeRequest("user-1")
      const res = makeResponse()
      const next = makeNext()

      await limiter(req as Request, res as unknown as Response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith() // called with no error
    })

    it("calls next() for requests up to the limit", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)

      for (let i = 0; i < TEST_CONFIG.max; i++) {
        const req = makeRequest("user-2")
        const res = makeResponse()
        const next = makeNext()

        await limiter(req as Request, res as unknown as Response, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(res.statusCode).toBe(200)
      }
    })

    it("sets X-RateLimit-Limit header", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const req = makeRequest("user-3")
      const res = makeResponse()
      const next = makeNext()

      await limiter(req as Request, res as unknown as Response, next)

      expect(res.headers["X-RateLimit-Limit"]).toBe(TEST_CONFIG.max)
    })

    it("sets X-RateLimit-Remaining header that decrements", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const userId = "user-4"

      // First request: remaining should be max - 1
      const req1 = makeRequest(userId)
      const res1 = makeResponse()
      await limiter(req1 as Request, res1 as unknown as Response, makeNext())
      expect(res1.headers["X-RateLimit-Remaining"]).toBe(TEST_CONFIG.max - 1)

      // Second request: remaining should be max - 2
      const req2 = makeRequest(userId)
      const res2 = makeResponse()
      await limiter(req2 as Request, res2 as unknown as Response, makeNext())
      expect(res2.headers["X-RateLimit-Remaining"]).toBe(TEST_CONFIG.max - 2)
    })

    it("sets TTL on first request only", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const userId = "user-5"

      // First request — should set TTL
      await limiter(
        makeRequest(userId) as Request,
        makeResponse() as unknown as Response,
        makeNext()
      )
      expect(mockRedis.expire).toHaveBeenCalledTimes(1)

      // Second request — should NOT set TTL again
      await limiter(
        makeRequest(userId) as Request,
        makeResponse() as unknown as Response,
        makeNext()
      )
      expect(mockRedis.expire).toHaveBeenCalledTimes(1) // still 1
    })
  })

  // ── Rejects requests over the limit ────────────────────────────────────
  describe("requests over the limit", () => {
    it("returns 429 when limit is exceeded", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const userId = "user-over-limit"

      // Make max + 1 requests
      for (let i = 0; i <= TEST_CONFIG.max; i++) {
        const req = makeRequest(userId)
        const res = makeResponse()
        const next = makeNext()

        await limiter(req as Request, res as unknown as Response, next)

        if (i < TEST_CONFIG.max) {
          expect(next).toHaveBeenCalledTimes(1)
        } else {
          // The (max + 1)th request should be rejected
          expect(res.statusCode).toBe(429)
          expect(next).not.toHaveBeenCalled()
        }
      }
    })

    it("returns the configured error message in the response body", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const userId = "user-message-check"

      // Exhaust the limit
      for (let i = 0; i <= TEST_CONFIG.max; i++) {
        const req = makeRequest(userId)
        const res = makeResponse()
        await limiter(req as Request, res as unknown as Response, makeNext())

        if (i === TEST_CONFIG.max) {
          expect((res.body as { error?: string }).error).toBe(TEST_CONFIG.message)
        }
      }
    })

    it("sets Retry-After header when limit is exceeded", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const userId = "user-retry-after"

      for (let i = 0; i <= TEST_CONFIG.max; i++) {
        const req = makeRequest(userId)
        const res = makeResponse()
        await limiter(req as Request, res as unknown as Response, makeNext())

        if (i === TEST_CONFIG.max) {
          expect(res.headers["Retry-After"]).toBeDefined()
        }
      }
    })

    it("X-RateLimit-Remaining is 0 when limit is exceeded", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const userId = "user-remaining-zero"

      for (let i = 0; i <= TEST_CONFIG.max; i++) {
        const req = makeRequest(userId)
        const res = makeResponse()
        await limiter(req as Request, res as unknown as Response, makeNext())

        if (i === TEST_CONFIG.max) {
          expect(res.headers["X-RateLimit-Remaining"]).toBe(0)
        }
      }
    })
  })

  // ── User isolation ──────────────────────────────────────────────────────
  describe("user isolation", () => {
    it("different users have independent rate limit counters", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)

      // User A exhausts their limit
      for (let i = 0; i <= TEST_CONFIG.max; i++) {
        await limiter(
          makeRequest("user-A") as Request,
          makeResponse() as unknown as Response,
          makeNext()
        )
      }

      // User B should still be allowed (fresh counter)
      const reqB = makeRequest("user-B")
      const resB = makeResponse()
      const nextB = makeNext()

      await limiter(reqB as Request, resB as unknown as Response, nextB)

      expect(nextB).toHaveBeenCalledTimes(1)
      expect(resB.statusCode).toBe(200)
    })
  })

  // ── No user (skips rate limiting) ──────────────────────────────────────
  describe("unauthenticated requests", () => {
    it("calls next() without rate limiting when req.user is undefined", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const req = {} // no user
      const res = makeResponse()
      const next = makeNext()

      await limiter(req as Request, res as unknown as Response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(mockRedis.incr).not.toHaveBeenCalled() // no Redis call
    })
  })

  // ── Redis failure (fail open) ───────────────────────────────────────────
  describe("Redis failure — fail open", () => {
    it("calls next() when Redis throws (fail open)", async () => {
      mockRedis.incr.mockRejectedValueOnce(new Error("Redis connection refused"))

      const limiter = createRateLimiter(TEST_CONFIG)
      const req = makeRequest("user-redis-down")
      const res = makeResponse()
      const next = makeNext()

      await limiter(req as Request, res as unknown as Response, next)

      // Should fail open — allow the request despite Redis being down
      expect(next).toHaveBeenCalledTimes(1)
    })
  })
})
