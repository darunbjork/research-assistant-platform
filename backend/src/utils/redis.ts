// TODO: Creates and exports a single shared Redis client.
//
// ! WHY ONE SHARED INSTANCE:
// * Each Redis connection uses a TCP socket and memory.
// Creating a new client per request (like a naive implementation might do)
// exhausts the connection pool under load.
// One shared client = one persistent connection = efficient.
//
// This is the same reason we use one PrismaClient in app.ts.

import Redis from "ioredis"
import { logStartup, logError } from "./logger"

// ── Create the Redis Client ───────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

export const redis = new Redis(REDIS_URL, {
  // Retry strategy: if Redis goes down, retry with exponential backoff
  // This prevents the app from crashing on a temporary Redis outage
  retryStrategy(times: number): number | null {
    if (times > 5) {
      // After 5 attempts, stop retrying
      // The app will continue without Redis — cache misses become API calls
      logError(
        "Redis retry limit exceeded — running without cache",
        new Error("Redis unavailable"),
        {
          service: "Redis",
        }
      )
      return null
    }
    // Wait: 100ms, 200ms, 400ms, 800ms, 1600ms between retries
    return Math.min(times * 100, 2000)
  },
  // Do not log every command (too noisy in development)
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
})

// ── Connection Event Handlers ─────────────────────────────────────────────
redis.on("connect", () => {
  logStartup("Redis connected", { service: "Redis", url: REDIS_URL })
})

redis.on("error", (error: Error) => {
  // Log the error but DO NOT throw — Redis being down is non-fatal.
  // The app continues; embeddings are computed fresh every time (no cache).
  logError("Redis connection error", error, { service: "Redis" })
})

redis.on("reconnecting", () => {
  logStartup("Redis reconnecting...", { service: "Redis" })
})

// ── Health Check Helper ───────────────────────────────────────────────────
// Used by the /health endpoint to verify Redis is reachable
export async function checkRedisHealth(): Promise<"ok" | "error"> {
  try {
    const pong = await redis.ping()
    return pong === "PONG" ? "ok" : "error"
  } catch {
    return "error"
  }
}

export default redis
