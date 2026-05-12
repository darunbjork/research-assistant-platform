// backend/src/middleware/rate-limit.middleware.ts
// Per-user, per-endpoint rate limiting backed by Redis.
//
// WHY REDIS-BACKED RATE LIMITING:
// Memory-based rate limiting (in-process) resets on every server restart
// and does not share state across multiple server instances.
//
// Redis-backed rate limiting:
//   ✅ Persists across server restarts
//   ✅ Shared across multiple server instances (horizontal scaling)
//   ✅ TTL automatically clears expired windows
//   ✅ Atomic increments (no race conditions)
//
// SLIDING WINDOW ALGORITHM:
// For each request, increment a counter in Redis.
// Key: "rl:{endpoint}:{userId}" with TTL = window duration.
// If counter > limit: reject with 429.
// When TTL expires: counter resets to 0.
//
// WHY PER-USER NOT PER-IP:
// IP-based limiting fails in two ways:
//   1. NAT: 100 users behind one corporate IP all share the limit
//   2. VPN: one user can bypass limit by switching IP
// User ID (from JWT) is the correct identity for AI systems.

import type { Request, Response, NextFunction } from "express"
import { redis } from "../utils/redis"
import { logRagEvent } from "../utils/logger"
import { fail } from "../types/api.types"

// ── Rate Limit Configuration ───────────────────────────────────────────────

export interface RateLimitConfig {
  windowMs: number // time window in milliseconds
  max: number // max requests per window per user
  message: string // error message when limit exceeded
  keyPrefix: string // prefix for Redis key (identifies the endpoint)
  skipSuccessful?: boolean // if true, only count failed requests (not used here)
}

// ── Predefined Limits ─────────────────────────────────────────────────────
// Each endpoint has its own limit based on its cost.

// Cheap endpoint: listing documents, getting status
export const LIGHT_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 200,
  message: "Too many requests. Limit: 200 per hour.",
  keyPrefix: "light",
}

// Medium endpoint: RAG query (1-2 Gemini calls)
export const RAG_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  message:
    "RAG query limit reached. Limit: 60 queries per hour. Please wait before querying again.",
  keyPrefix: "rag",
}

// Heavy endpoint: agent chat (up to 12 Gemini calls with evaluation)
export const AGENT_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: "Agent chat limit reached. Limit: 30 agent sessions per hour.",
  keyPrefix: "agent",
}

// Upload endpoint: document ingestion (Gemini embedding)
export const UPLOAD_LIMIT: RateLimitConfig = {
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20,
  message: "Document upload limit reached. Limit: 20 uploads per day.",
  keyPrefix: "upload",
}

// Evaluation endpoint: 3 Gemini calls per evaluation
export const EVAL_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: "Evaluation limit reached. Limit: 20 evaluations per hour.",
  keyPrefix: "eval",
}

// ── Rate Limiter Factory ──────────────────────────────────────────────────
// Returns an Express middleware function for the given config.

export function createRateLimiter(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // authMiddleware must run before rate limiting.
    // If no user: let authMiddleware handle the 401.
    if (!req.user) {
      next()
      return
    }

    const userId = req.user.userId
    const key = `rl:${config.keyPrefix}:${userId}`
    const windowS = Math.ceil(config.windowMs / 1000)

    try {
      // Atomic increment — Redis INCR is atomic (no race conditions)
      const count = await redis.incr(key)

      // Set TTL only on first request (count === 1)
      // If we set TTL on every request, the window never expires
      if (count === 1) {
        await redis.expire(key, windowS)
      }

      // Get remaining TTL for Retry-After header
      const ttl = await redis.ttl(key)

      // Set standard rate limit headers (RFC 6585)
      res.setHeader("X-RateLimit-Limit", config.max)
      res.setHeader("X-RateLimit-Remaining", Math.max(0, config.max - count))
      res.setHeader("X-RateLimit-Reset", Math.ceil(Date.now() / 1000) + ttl)

      if (count > config.max) {
        // Rate limit exceeded
        res.setHeader("Retry-After", ttl)

        logRagEvent("ingest", "Rate limit exceeded", {
          service: "RateLimiter",
          userId,
          keyPrefix: config.keyPrefix,
        })

        res.status(429).json({
          ...fail(config.message),
          retryAfter: ttl,
          limit: config.max,
          windowMs: config.windowMs,
        })
        return
      }

      next()
      // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-unused-vars
    } catch (error: unknown) {
      // Redis failure — fail open (allow the request)
      // It is better to serve requests when Redis is down than to block all users.
      logRagEvent("ingest", "Rate limiter Redis error — failing open", {
        service: "RateLimiter",
        userId,
      })
      next()
    }
  }
}

// ── Rate Limit Status ─────────────────────────────────────────────────────
// Returns the current rate limit status for a user and endpoint.
// Used by the /api/v1/rate-limit/status endpoint.

export interface RateLimitStatus {
  endpoint: string
  limit: number
  used: number
  remaining: number
  resetsInSec: number
}

export async function getRateLimitStatus(
  userId: string,
  configs: RateLimitConfig[]
): Promise<RateLimitStatus[]> {
  return Promise.all(
    configs.map(async config => {
      const key = `rl:${config.keyPrefix}:${userId}`

      try {
        const [countStr, ttl] = await Promise.all([redis.get(key), redis.ttl(key)])

        const used = countStr !== null ? parseInt(countStr, 10) : 0

        return {
          endpoint: config.keyPrefix,
          limit: config.max,
          used,
          remaining: Math.max(0, config.max - used),
          resetsInSec: ttl > 0 ? ttl : 0,
        }
      } catch {
        return {
          endpoint: config.keyPrefix,
          limit: config.max,
          used: 0,
          remaining: config.max,
          resetsInSec: 0,
        }
      }
    })
  )
}
