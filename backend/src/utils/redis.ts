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
import { env } from "../config/env"

// ── Create the Redis Client ───────────────────────────────────────────────
const REDIS_URL = env.REDIS_URL

export const redis = new Redis(REDIS_URL, {
  // Retry strategy: reconnect forever with capped backoff.
  // NEVER return null — returning null permanently stops the client, so a
  // Redis restart would leave the app running without cache until a manual
  // process restart. Backoff: 200ms, 400ms, … capped at 5s between retries.
  retryStrategy(times: number): number {
    // Log only every 10th attempt so a long outage doesn't flood the logs.
    if (times % 10 === 0) {
      logError(
        `Redis still unavailable after ${times} attempts — continuing to retry`,
        new Error("Redis unavailable"),
        {
          service: "Redis",
        }
      )
    }
    return Math.min(times * 200, 5000)
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
