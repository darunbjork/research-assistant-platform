// backend/src/utils/global-budget.ts
// Global daily LLM budget — a kill switch that stops one person registering
// many accounts from running up an unbounded Gemini bill. Per-user rate
// limits cannot do this: they are per user by definition.

import { redis } from "./redis"
import { logError } from "./logger"
import { globalBudgetUsed } from "./metrics"

const DEFAULT_MAX = 2000
// Keys live for 48h so yesterday's counter can still be inspected after
// the UTC date rolls over.
const KEY_TTL_SECONDS = 48 * 60 * 60

/** Today's budget key: `budget:llm:<YYYY-MM-DD in UTC>`. */
export function globalBudgetKey(now: Date = new Date()): string {
  return `budget:llm:${now.toISOString().slice(0, 10)}`
}

/**
 * Daily cap on LLM-calling operations across ALL users.
 *
 * Read from `GLOBAL_DAILY_LLM_CALLS_MAX`. Task 3.1 moves env validation into
 * a Zod schema; until then this reads process.env directly (see
 * FOUND_DURING_FIX.md F3). Missing/invalid values fall back to 2000.
 */
export function getGlobalDailyMax(): number {
  const raw = process.env.GLOBAL_DAILY_LLM_CALLS_MAX
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX
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
