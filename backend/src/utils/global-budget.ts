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
 * Voice budget script — CHECK-BEFORE-INCREMENT (Day 2.5).
 *
 * A voice refusal must leave the GLOBAL counter untouched: otherwise a voice
 * flood that keeps hitting the 40 % sub-cap would still drain the shared
 * daily budget and defeat the sub-cap entirely. Lua runs atomically inside
 * Redis, so read-check-increment cannot race another caller. Returns
 * [-1, -1] when either cap would be exceeded (nothing is written), else the
 * post-increment totals [globalUsed, voiceUsed]. EXPIRE … NX keeps the
 * 48-hour TTL semantics of the global counter (set once, never extended).
 */
const VOICE_BUDGET_SCRIPT = `
local cost = tonumber(ARGV[1])
local global_max = tonumber(ARGV[2])
local voice_max = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local global_used = tonumber(redis.call('GET', KEYS[1]) or 0)
local voice_used = tonumber(redis.call('GET', KEYS[2]) or 0)
if (voice_used + cost > voice_max) or (global_used + cost > global_max) then
  return {-1, -1}
end
local global_new = redis.call('INCRBY', KEYS[1], cost)
local voice_new = redis.call('INCRBY', KEYS[2], cost)
redis.call('EXPIRE', KEYS[1], ttl, 'NX')
redis.call('EXPIRE', KEYS[2], ttl, 'NX')
return {global_new, voice_new}
`

/**
 * Consume `cost` units for a VOICE operation: checks BOTH caps first and
 * only then increments BOTH `budget:llm:<date>` and `budget:voice:<date>`
 * (one atomic Lua script). Refused calls change nothing — the shared global
 * counter is never drained by a flood the sub-cap is already rejecting.
 * FAILS CLOSED on any Redis error, exactly like consumeGlobalBudget.
 */
export async function consumeVoiceBudget(cost: number): Promise<boolean> {
  const globalMax = getGlobalDailyMax()
  const voiceMax = getVoiceDailyMax()
  const now = new Date()
  const globalKey = globalBudgetKey(now)
  const voiceKey = voiceBudgetKey(now)

  try {
    const result: unknown = await redis.eval(
      VOICE_BUDGET_SCRIPT,
      2,
      globalKey,
      voiceKey,
      String(cost),
      String(globalMax),
      String(voiceMax),
      String(KEY_TTL_SECONDS)
    )

    if (!Array.isArray(result)) {
      throw new Error("Voice budget script returned no result")
    }
    const [globalUsedRaw, voiceUsedRaw] = result as [unknown, unknown]
    const globalUsed = Number(globalUsedRaw)
    const voiceUsed = Number(voiceUsedRaw)
    if (!Number.isFinite(globalUsed) || !Number.isFinite(voiceUsed)) {
      throw new Error("Unexpected voice budget response from Redis")
    }
    if (globalUsed < 0 || voiceUsed < 0) {
      // Refused by a cap — check-before-increment wrote nothing.
      return false
    }

    globalBudgetUsed.set(globalUsed)
    return true
  } catch (error: unknown) {
    logError("Voice budget check failed — failing closed", error, {
      service: "GlobalBudget",
    })
    return false
  }
}
