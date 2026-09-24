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
}

export const LIGHT_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  max: 200,
  message: "Too many requests. Limit: 200 per hour.",
  keyPrefix: "light",
}

// Medium endpoint: RAG query (1-2 Gemini calls)
export const RAG_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  max: 60,
  message:
    "RAG query limit reached. Limit: 60 queries per hour. Please wait before querying again.",
  keyPrefix: "rag",
}

export const AGENT_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: "Agent chat limit reached. Limit: 30 agent sessions per hour.",
  keyPrefix: "agent",
}

export const UPLOAD_LIMIT: RateLimitConfig = {
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20,
  message: "Document upload limit reached. Limit: 20 uploads per day.",
  keyPrefix: "upload",
}

export const EVAL_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: "Evaluation limit reached. Limit: 20 evaluations per hour.",
  keyPrefix: "eval",
}

export function createRateLimiter(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      next()
      return
    }

    const userId = req.user.userId
    const key = `rl:${config.keyPrefix}:${userId}`
    const windowS = Math.ceil(config.windowMs / 1000)

    try {
      const count = await redis.incr(key)

      if (count === 1) {
        await redis.expire(key, windowS)
      }

      const ttl = await redis.ttl(key)

      res.setHeader("X-RateLimit-Limit", config.max)
      res.setHeader("X-RateLimit-Remaining", Math.max(0, config.max - count))
      res.setHeader("X-RateLimit-Reset", Math.ceil(Date.now() / 1000) + ttl)

      if (count > config.max) {
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
      logRagEvent("ingest", "Rate limiter Redis error — failing open", {
        service: "RateLimiter",
        userId,
      })
      next()
    }
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
