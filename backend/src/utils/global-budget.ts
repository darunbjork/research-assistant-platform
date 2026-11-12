// backend/src/utils/global-budget.ts
// Global daily LLM budget — a kill switch that stops one person registering
// many accounts from running up an unbounded Gemini bill. Per-user rate
// limits cannot do this: they are per user by definition.

import { redis } from "./redis"
import { logError } from "./logger"
import { globalBudgetUsed } from "./metrics"
import { env } from "../config/env"

// Keys live for 48h so yesterday's counter can still be inspected after
// the UTC date rolls over.
const KEY_TTL_SECONDS = 48 * 60 * 60

/** Today's budget key: `budget:llm:<YYYY-MM-DD in UTC>`. */
export function globalBudgetKey(now: Date = new Date()): string {
  return `budget:llm:${now.toISOString().slice(0, 10)}`
}

/**
 * Voice sub-cap share of the global daily max (confirmed by Darun, Day 1
 * review): voice may consume at most 40 % of GLOBAL_DAILY_LLM_CALLS_MAX per
 * UTC day, so a voice burst can never trigger "Daily capacity reached" for
 * text users — at least 60 % of the budget stays reserved for them.
 */
export const VOICE_BUDGET_SHARE = 0.4

/** Today's voice budget key: `budget:voice:<YYYY-MM-DD in UTC>`. */
export function voiceBudgetKey(now: Date = new Date()): string {
  return `budget:voice:${now.toISOString().slice(0, 10)}`
}

/** Daily cap on voice units: floor(40 % of the global max) — 800 at default 2000. */
export function getVoiceDailyMax(): number {
  return Math.floor(getGlobalDailyMax() * VOICE_BUDGET_SHARE)
}

/**
 * Daily cap on LLM-calling operations across ALL users, validated once by
 * the Zod env schema (GLOBAL_DAILY_LLM_CALLS_MAX, default 2000 — see
 * src/config/env.ts).
 */
export function getGlobalDailyMax(): number {
  return env.GLOBAL_DAILY_LLM_CALLS_MAX
}

/**
 * Consume `cost` units from today's global budget.
 *
 * Increments `budget:llm:<YYYY-MM-DD UTC>` (48-hour TTL) and returns false
 * once the counter is over the max. FAILS CLOSED: if Redis is unreachable we
 * cannot prove we are under the cap, so the expensive call is refused —
 * a stopped pipeline is better than an unbounded bill.
 */
export async function consumeGlobalBudget(cost: number): Promise<boolean> {
  const max = getGlobalDailyMax()
  const key = globalBudgetKey()

  try {
    const results = await redis.multi().incrby(key, cost).expire(key, KEY_TTL_SECONDS, "NX").exec()

    if (!results) {
      throw new Error("Global budget transaction aborted")
    }

    const used = Number(results[0]?.[1])
    if (!Number.isFinite(used)) {
      throw new Error("Unexpected global budget response from Redis")
    }

    globalBudgetUsed.set(used)
    return used <= max
  } catch (error: unknown) {
    logError("Global budget check failed — failing closed", error, {
      service: "GlobalBudget",
    })
    return false
  }
}

/**
 * Consume `cost` units for a VOICE operation: increments BOTH
 * `budget:voice:<date>` and `budget:llm:<date>` in one transaction and
 * returns false when either the voice sub-cap (40 %) or the global max is
 * exceeded. Voice units therefore count toward the global budget too, and
 * the sub-cap bounds how much of it they may take. FAILS CLOSED on any
 * Redis error, exactly like consumeGlobalBudget.
 *
 * Note: like the global counter, a refused call has already incremented the
 * counters — the overshoot is bounded by a single call's cost and the next
 * call is refused.
 */
export async function consumeVoiceBudget(cost: number): Promise<boolean> {
  const globalMax = getGlobalDailyMax()
  const voiceMax = getVoiceDailyMax()
  const now = new Date()
  const globalKey = globalBudgetKey(now)
  const voiceKey = voiceBudgetKey(now)

  try {
    const results = await redis
      .multi()
      .incrby(globalKey, cost)
      .expire(globalKey, KEY_TTL_SECONDS, "NX")
      .incrby(voiceKey, cost)
      .expire(voiceKey, KEY_TTL_SECONDS, "NX")
      .exec()

    if (!results) {
      throw new Error("Voice budget transaction aborted")
    }

    // MULTI/EXEC results follow command order: [incrby llm, expire llm,
    // incrby voice, expire voice].
    const globalUsed = Number(results[0]?.[1])
    const voiceUsed = Number(results[2]?.[1])
    if (!Number.isFinite(globalUsed) || !Number.isFinite(voiceUsed)) {
      throw new Error("Unexpected voice budget response from Redis")
    }

    globalBudgetUsed.set(globalUsed)
    return globalUsed <= globalMax && voiceUsed <= voiceMax
  } catch (error: unknown) {
    logError("Voice budget check failed — failing closed", error, {
      service: "GlobalBudget",
    })
    return false
  }
}
