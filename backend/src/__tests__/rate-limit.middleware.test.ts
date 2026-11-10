import type { Request, Response } from "express"
import type { RateLimitConfig } from "../middleware/rate-limit.middleware"

// ── Mock Redis ────────────────────────────────────────────────────────────
// We mock the entire redis module so the rate limiter uses our fake Redis.
// consumeRateLimit() drives everything through multi().incr().expire(NX).ttl().exec(),
// so the mock exposes a chainable pipeline that honours EXPIRE NX semantics.
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
          expireResult = 0 // key already has a TTL — NX is a no-op
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
const { createRateLimiter, createIpRateLimiter, consumeRateLimit, LOGIN_LIMIT, REGISTER_LIMIT } =
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
    failMode: "open",
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

    it("does not restart the window TTL on later requests (EXPIRE NX)", async () => {
      const limiter = createRateLimiter(TEST_CONFIG)
      const userId = "user-5"
      const key = `rl:test:${userId}`

      // First request — TTL is set to the window length (60s).
      await limiter(
        makeRequest(userId) as Request,
        makeResponse() as unknown as Response,
        makeNext()
      )
      expect(mockTtlStore.get(key)).toBe(60)

      // Simulate the window ageing on the Redis side, then hit the limiter
      // again: EXPIRE NX must leave the existing TTL untouched.
      mockTtlStore.set(key, 42)
      await limiter(
        makeRequest(userId) as Request,
        makeResponse() as unknown as Response,
        makeNext()
      )
      expect(mockTtlStore.get(key)).toBe(42)
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
      expect(mockRedis.multi).not.toHaveBeenCalled() // no Redis call
    })
  })

  // ── Redis failure (fail open) ───────────────────────────────────────────
  describe("Redis failure — fail open", () => {
    it("calls next() when Redis throws (fail open)", async () => {
      mockRedis.multi.mockImplementationOnce(() => {
        throw new Error("Redis connection refused")
      })

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

// ── consumeRateLimit() — the Express-independent core ─────────────────────
describe("consumeRateLimit()", () => {
  const CORE_CONFIG: RateLimitConfig = {
    windowMs: 60_000,
    max: 2,
    message: "core limit",
    keyPrefix: "core",
    failMode: "closed",
  }

  beforeEach(() => {
    mockRedisStore.clear()
    mockTtlStore.clear()
    jest.clearAllMocks()
  })

  it("allows requests under the limit and reports remaining", async () => {
    const first = await consumeRateLimit("user-1", CORE_CONFIG)
    expect(first).toEqual({ allowed: true, remaining: 1, retryAfterSec: 60 })

    const second = await consumeRateLimit("user-1", CORE_CONFIG)
    expect(second.allowed).toBe(true)
    expect(second.remaining).toBe(0)
  })

  it("denies once the limit is exceeded, with the TTL as retryAfterSec", async () => {
    await consumeRateLimit("user-2", CORE_CONFIG)
    await consumeRateLimit("user-2", CORE_CONFIG)

    const third = await consumeRateLimit("user-2", CORE_CONFIG)
    expect(third.allowed).toBe(false)
    expect(third.remaining).toBe(0)
    expect(third.retryAfterSec).toBe(60)
  })

  it("scopes counters by subject (user and ip: subjects are independent)", async () => {
    await consumeRateLimit("ip:1.2.3.4", CORE_CONFIG)

    const other = await consumeRateLimit("ip:9.9.9.9", CORE_CONFIG)
    expect(other.allowed).toBe(true)
    expect(other.remaining).toBe(1)

    const same = await consumeRateLimit("ip:1.2.3.4", CORE_CONFIG)
    expect(same.remaining).toBe(0)
  })

  it("uses the rl:<prefix>:<subject> key format", async () => {
    await consumeRateLimit("user-5", CORE_CONFIG)
    expect(mockRedisStore.get("rl:core:user-5")).toBe(1)
  })

  it("fails closed (retryAfterSec 60) when Redis is down", async () => {
    mockRedis.multi.mockImplementationOnce(() => {
      throw new Error("Redis connection refused")
    })

    const decision = await consumeRateLimit("user-3", { ...CORE_CONFIG, failMode: "closed" })
    expect(decision).toEqual({ allowed: false, remaining: 0, retryAfterSec: 60 })
  })

  it("fails open when Redis is down and failMode is open", async () => {
    mockRedis.multi.mockImplementationOnce(() => {
      throw new Error("Redis connection refused")
    })

    const decision = await consumeRateLimit("user-4", { ...CORE_CONFIG, failMode: "open" })
    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(CORE_CONFIG.max)
  })
})

// ── createIpRateLimiter() — per-IP limits for auth endpoints (D20) ────────
describe("createIpRateLimiter()", () => {
  const IP_CONFIG: RateLimitConfig = {
    windowMs: 900_000, // 15 minutes
    max: 3,
    message: "Too many attempts",
    keyPrefix: "ip-test",
    failMode: "open",
  }

  function makeIpRequest(ip: string): Partial<Request> {
    return { ip }
  }

  beforeEach(() => {
    mockRedisStore.clear()
    mockTtlStore.clear()
    jest.clearAllMocks()
  })

  it("keys the counter by ip:<address>", async () => {
    const limiter = createIpRateLimiter(IP_CONFIG)

    await limiter(
      makeIpRequest("203.0.113.7") as Request,
      makeResponse() as unknown as Response,
      makeNext()
    )

    expect(mockRedisStore.get("rl:ip-test:ip:203.0.113.7")).toBe(1)
  })

  it("allows up to the max per IP and denies the next with 429", async () => {
    const limiter = createIpRateLimiter(IP_CONFIG)

    for (let i = 0; i < IP_CONFIG.max; i++) {
      const res = makeResponse()
      const next = makeNext()
      await limiter(makeIpRequest("198.51.100.9") as Request, res as unknown as Response, next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(res.statusCode).toBe(200)
    }

    const res = makeResponse()
    const next = makeNext()
    await limiter(makeIpRequest("198.51.100.9") as Request, res as unknown as Response, next)

    expect(res.statusCode).toBe(429)
    expect(next).not.toHaveBeenCalled()
    expect(res.headers["Retry-After"]).toBeDefined()
    expect(res.headers["X-RateLimit-Remaining"]).toBe(0)
    expect((res.body as { error?: string }).error).toBe(IP_CONFIG.message)
  })

  it("keeps different IPs independent", async () => {
    const limiter = createIpRateLimiter(IP_CONFIG)

    // IP A exhausts its window
    for (let i = 0; i <= IP_CONFIG.max; i++) {
      await limiter(
        makeIpRequest("192.0.2.1") as Request,
        makeResponse() as unknown as Response,
        makeNext()
      )
    }

    // IP B still has room
    const res = makeResponse()
    const next = makeNext()
    await limiter(makeIpRequest("192.0.2.2") as Request, res as unknown as Response, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
  })

  it("fails open when Redis is down", async () => {
    mockRedis.multi.mockImplementationOnce(() => {
      throw new Error("Redis connection refused")
    })

    const limiter = createIpRateLimiter(IP_CONFIG)
    const next = makeNext()
    await limiter(
      makeIpRequest("203.0.113.8") as Request,
      makeResponse() as unknown as Response,
      next
    )

    expect(next).toHaveBeenCalledTimes(1)
  })

  it("fails closed when Redis is down and failMode is closed", async () => {
    mockRedis.multi.mockImplementationOnce(() => {
      throw new Error("Redis connection refused")
    })

    const limiter = createIpRateLimiter({ ...IP_CONFIG, failMode: "closed" })
    const res = makeResponse()
    const next = makeNext()
    await limiter(makeIpRequest("203.0.113.9") as Request, res as unknown as Response, next)

    expect(res.statusCode).toBe(429)
    expect(next).not.toHaveBeenCalled()
  })
})

// ── Auth IP limits pinned to the plan's numbers (task 2.5) ────────────────
describe("auth IP limit configs", () => {
  it("LOGIN_LIMIT is 10 per 15 minutes, fail open, keyed login", () => {
    expect(LOGIN_LIMIT).toMatchObject({
      windowMs: 15 * 60 * 1000,
      max: 10,
      failMode: "open",
      keyPrefix: "login",
    })
  })

  it("REGISTER_LIMIT is 5 per hour, fail closed, keyed register", () => {
    expect(REGISTER_LIMIT).toMatchObject({
      windowMs: 60 * 60 * 1000,
      max: 5,
      failMode: "closed",
      keyPrefix: "register",
    })
  })
})
