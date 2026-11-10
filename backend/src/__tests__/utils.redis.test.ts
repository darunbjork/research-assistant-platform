// backend/src/__tests__/utils.redis.test.ts
//
// Tests for the shared Redis client (utils/redis) and the singleton cache
// (cache/index). ioredis is mocked so no real connection is ever attempted —
// the client constructor and its retryStrategy are inspected instead.

jest.mock("ioredis")

import Redis from "ioredis"
import { redis, checkRedisHealth } from "../utils/redis"
import { searchCache } from "../cache/index"
import { SearchCache } from "../cache/search.cache"

type ConstructorArgs = [string, { retryStrategy: (times: number) => number }]

// Captured at module load — jest's clearMocks (config) wipes call history
// before each test, so the constructor call made while utils/redis was being
// imported must be copied here, during module evaluation.
const constructorCalls = (Redis as unknown as jest.Mock).mock.calls.slice() as ConstructorArgs[]

function getConstructorArgs(): ConstructorArgs {
  const args = constructorCalls[0]
  if (args === undefined) {
    throw new Error("Redis constructor was never called")
  }
  return args
}

describe("utils/redis", () => {
  it("creates one shared client from REDIS_URL", () => {
    expect(constructorCalls).toHaveLength(1)
    const [url] = getConstructorArgs()
    expect(url).toBe(process.env.REDIS_URL ?? "redis://localhost:6379")
    expect(redis).toBeDefined()
  })

  describe("retryStrategy (D12: must never stop retrying)", () => {
    it("backs off 200ms per attempt", () => {
      const { retryStrategy } = getConstructorArgs()[1]
      expect(retryStrategy(1)).toBe(200)
    })

    it("caps the delay at 5 seconds", () => {
      const { retryStrategy } = getConstructorArgs()[1]
      expect(retryStrategy(100)).toBe(5000)
      expect(retryStrategy(1000)).toBe(5000)
    })

    it("never returns null for any attempt count (reconnects forever)", () => {
      const { retryStrategy } = getConstructorArgs()[1]
      for (const times of [0, 1, 5, 6, 10, 50, 999]) {
        const delay = retryStrategy(times)
        expect(delay).not.toBeNull()
        expect(typeof delay).toBe("number")
        expect(delay).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe("checkRedisHealth()", () => {
    it("returns ok when Redis answers PONG", async () => {
      ;(redis.ping as jest.Mock).mockResolvedValue("PONG")
      await expect(checkRedisHealth()).resolves.toBe("ok")
    })

    it("returns error when Redis answers something unexpected", async () => {
      ;(redis.ping as jest.Mock).mockResolvedValue("NOPE")
      await expect(checkRedisHealth()).resolves.toBe("error")
    })

    it("returns error when Redis is unreachable", async () => {
      ;(redis.ping as jest.Mock).mockRejectedValue(new Error("ECONNREFUSED"))
      await expect(checkRedisHealth()).resolves.toBe("error")
    })
  })
})

describe("cache/index", () => {
  it("exports one shared SearchCache built on the shared redis client", () => {
    expect(searchCache).toBeInstanceOf(SearchCache)
  })
})
