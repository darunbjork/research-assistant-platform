import type { Request, Response, NextFunction } from "express"
import { redis } from "../utils/redis"
import { logRagEvent } from "../utils/logger"
import { fail } from "../types/api.types"

// ── Rate Limit Configuration ───────────────────────────────────────────────

export interface RateLimitConfig {
  windowMs: number
  max: number
  message: string
  keyPrefix: string
  skipSuccessful?: boolean
  /**
   * Behaviour when Redis itself is unavailable:
   * - "open": allow the request anyway (used for cheap, non-billable limits
   *   such as LIGHT_LIMIT, where losing enforcement is better than downtime).
   * - "closed": deny with retryAfterSec: 60. Every limit that spends money
   *   (RAG, agent, upload, eval) uses this: when Redis is down we prefer
   *   refusing an expensive request to an unbounded bill.
   */
  failMode: "open" | "closed"
}

export const LIGHT_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  max: 200,
  message: "Too many requests. Limit: 200 per hour.",
  keyPrefix: "light",
  failMode: "open",
}

// Medium endpoint: RAG query (1-2 Gemini calls)
export const RAG_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  max: 60,
  message:
    "RAG query limit reached. Limit: 60 queries per hour. Please wait before querying again.",
  keyPrefix: "rag",
  failMode: "closed",
}

export const AGENT_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: "Agent chat limit reached. Limit: 30 agent sessions per hour.",
  keyPrefix: "agent",
  failMode: "closed",
}

export const UPLOAD_LIMIT: RateLimitConfig = {
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20,
  message: "Document upload limit reached. Limit: 20 uploads per day.",
  keyPrefix: "upload",
  failMode: "closed",
}

export const EVAL_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: "Evaluation limit reached. Limit: 20 evaluations per hour.",
  keyPrefix: "eval",
  failMode: "closed",
}

// ── consumeRateLimit (Express-independent core) ────────────────────────────

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  /** Seconds until the window resets (the key TTL) — send as Retry-After when denied. */
  retryAfterSec: number
}

/**
 * Atomically consume one unit of the window for `subject` (a userId or an
 * `ip:<address>` string).
 *
 * INCR and the first-hit EXPIRE run in one MULTI/EXEC so a key can never
 * exist without a TTL (a crash between two separate calls used to leave
 * immortal keys). EXPIRE … NX only sets the TTL when the key has none, so an
 * existing window is never extended.
 *
 * Never throws: on Redis errors it returns a decision according to
 * `config.failMode` (see RateLimitConfig).
 */
export async function consumeRateLimit(
  subject: string,
  config: RateLimitConfig
): Promise<RateLimitDecision> {
  const key = `rl:${config.keyPrefix}:${subject}`
  const windowS = Math.ceil(config.windowMs / 1000)

  try {
    const results = await redis.multi().incr(key).expire(key, windowS, "NX").ttl(key).exec()

    if (!results) {
      throw new Error("Rate limit transaction aborted")
    }

    const count = Number(results[0]?.[1])
    const ttl = Number(results[2]?.[1])
    if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
      throw new Error("Unexpected rate limit response from Redis")
    }

    return {
      allowed: count <= config.max,
      remaining: Math.max(0, config.max - count),
      retryAfterSec: ttl,
    }
  } catch {
    if (config.failMode === "closed") {
      logRagEvent("ingest", "Rate limiter Redis error — failing closed", {
        service: "RateLimiter",
        subject,
        keyPrefix: config.keyPrefix,
      })
      return { allowed: false, remaining: 0, retryAfterSec: 60 }
    }

    logRagEvent("ingest", "Rate limiter Redis error — failing open", {
      service: "RateLimiter",
      subject,
      keyPrefix: config.keyPrefix,
    })
    return { allowed: true, remaining: config.max, retryAfterSec: 0 }
  }
}

// ── Express middleware wrapper ─────────────────────────────────────────────

export function createRateLimiter(
  config: RateLimitConfig
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      next()
      return
    }

    const userId = req.user.userId
    const decision = await consumeRateLimit(userId, config)

    res.setHeader("X-RateLimit-Limit", config.max)
    res.setHeader("X-RateLimit-Remaining", decision.remaining)
    res.setHeader("X-RateLimit-Reset", Math.ceil(Date.now() / 1000) + decision.retryAfterSec)

    if (!decision.allowed) {
      res.setHeader("Retry-After", decision.retryAfterSec)

      logRagEvent("ingest", "Rate limit exceeded", {
        service: "RateLimiter",
        userId,
        keyPrefix: config.keyPrefix,
      })

      res.status(429).json({
        ...fail(config.message),
        retryAfter: decision.retryAfterSec,
        limit: config.max,
        windowMs: config.windowMs,
      })
      return
    }

    next()
  }
}

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
