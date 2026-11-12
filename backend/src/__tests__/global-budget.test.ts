// backend/src/__tests__/global-budget.test.ts
//
// Task 2.4 (global daily LLM budget):
//   - consumeGlobalBudget() increments budget:llm:<YYYY-MM-DD UTC> with a
//     48-hour TTL and returns false once the counter is over the max.
//   - It FAILS CLOSED: Redis unavailable ⇒ the expensive call is refused.
//   - HTTP wiring: an LLM entry point returns exactly
//     { success: false, error: "Daily capacity reached, try again tomorrow" }
//     with status 503 when the budget is exhausted (eval entry point — the
//     cheapest controller to mount in a unit test).

// ── Mock Redis (chainable pipeline with INCRBY + EXPIRE NX semantics) ─────
const mockRedisStore = new Map<string, number>()
const mockTtlStore = new Map<string, number>()
let mockRedisDown = false

type Pipeline = {
  incrby: jest.Mock
  expire: jest.Mock
  exec: jest.Mock
}

const mockRedis = {
  multi: jest.fn((): Pipeline => {
    if (mockRedisDown) {
      throw new Error("Redis unavailable")
    }
    // One entry per queued command, in order — mirrors real MULTI/EXEC
    // results so callers can read INCRBY values positionally.
    let execResults: Array<[null, number]> = []
    const pipeline: Pipeline = {
      incrby: jest.fn(),
      expire: jest.fn(),
      exec: jest.fn(),
    }
    pipeline.incrby.mockImplementation((key: string, by: number) => {
      const next = (mockRedisStore.get(key) ?? 0) + by
      mockRedisStore.set(key, next)
      execResults.push([null, next])
      return pipeline
    })
    pipeline.expire.mockImplementation((key: string, seconds: number, nx?: string) => {
      if (!(nx === "NX" && mockTtlStore.has(key))) {
        mockTtlStore.set(key, seconds)
      }
      execResults.push([null, 1])
      return pipeline
    })
    pipeline.exec.mockImplementation(async () => {
      const results = execResults
      execResults = []
      return results
    })
    return pipeline
  }),
  // consumeVoiceBudget() EVALs the check-before-increment Lua script
  // (Day 2.5): the mock mirrors its exact semantics — refusal writes NOTHING.
  eval: jest.fn(
    async (_script: string, numkeys: number, ...rest: Array<string | number>): Promise<unknown> => {
      if (mockRedisDown) {
        throw new Error("Redis unavailable")
      }
      const keys = rest.slice(0, numkeys).map(String)
      const argv = rest.slice(numkeys).map(String)
      const globalKey = keys[0] ?? ""
      const voiceKey = keys[1] ?? ""
      const cost = Number(argv[0])
      const globalMax = Number(argv[1])
      const voiceMax = Number(argv[2])
      const ttl = Number(argv[3])

      const globalUsed = mockRedisStore.get(globalKey) ?? 0
      const voiceUsed = mockRedisStore.get(voiceKey) ?? 0
      if (voiceUsed + cost > voiceMax || globalUsed + cost > globalMax) {
        return [-1, -1] // refused — nothing incremented
      }
      const globalNew = globalUsed + cost
      const voiceNew = voiceUsed + cost
      mockRedisStore.set(globalKey, globalNew)
      mockRedisStore.set(voiceKey, voiceNew)
      if (!mockTtlStore.has(globalKey)) mockTtlStore.set(globalKey, ttl)
      if (!mockTtlStore.has(voiceKey)) mockTtlStore.set(voiceKey, ttl)
      return [globalNew, voiceNew]
    }
  ),
}

jest.mock("../utils/redis", () => ({ redis: mockRedis, default: mockRedis }))

// env is parsed once at import (task 3.1) — mock it with a mutable copy so
// GLOBAL_DAILY_LLM_CALLS_MAX can be flipped per test.
jest.mock("../config/env", () => {
  const actual = jest.requireActual("../config/env") as typeof import("../config/env")
  return { ...actual, env: { ...actual.env } }
})

// ── Eval service mocked so no Gemini call can happen ──────────────────────
const mockEvaluate = jest.fn().mockResolvedValue({ overallScore: 0.9 })
const mockEvaluateBatch = jest.fn().mockResolvedValue({ averageScore: 0.9 })

jest.mock("../services/evaluator.service", () => ({
  EvaluatorService: class {
    evaluate = (...args: unknown[]): Promise<unknown> => mockEvaluate(...args) as Promise<unknown>
    evaluateBatch = (...args: unknown[]): Promise<unknown> =>
      mockEvaluateBatch(...args) as Promise<unknown>
  },
}))

// ── Modules under test (required AFTER the mocks are defined) ─────────────
const {
  consumeGlobalBudget,
  consumeVoiceBudget,
  getGlobalDailyMax,
  getVoiceDailyMax,
  globalBudgetKey,
  voiceBudgetKey,
  VOICE_BUDGET_SHARE,
} = require("../utils/global-budget") as typeof import("../utils/global-budget")
const { globalBudgetUsed } = require("../utils/metrics") as typeof import("../utils/metrics")
const { EvalController } =
  require("../controllers/eval.controller") as typeof import("../controllers/eval.controller")
const { env } = require("../config/env") as typeof import("../config/env")

describe("consumeGlobalBudget", () => {
  beforeEach(() => {
    mockRedisStore.clear()
    mockTtlStore.clear()
    mockRedisDown = false
    jest.clearAllMocks()
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 2000
  })

  it("increments today's UTC budget key by the cost and allows when under the max", async () => {
    await expect(consumeGlobalBudget(1)).resolves.toBe(true)

    const key = globalBudgetKey()
    expect(key).toBe(`budget:llm:${new Date().toISOString().slice(0, 10)}`)
    expect(mockRedisStore.get(key)).toBe(1)
    // 48-hour TTL, applied on first use only (EXPIRE NX)
    expect(mockTtlStore.get(key)).toBe(48 * 60 * 60)
  })

  it("returns false once the counter goes over the max", async () => {
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 10

    await expect(consumeGlobalBudget(10)).resolves.toBe(true) // exactly at the cap
    await expect(consumeGlobalBudget(1)).resolves.toBe(false) // 11 > 10
  })

  it("fails closed when Redis itself is unavailable", async () => {
    mockRedisDown = true

    await expect(consumeGlobalBudget(1)).resolves.toBe(false)
  })

  it("fails closed when Redis returns no transaction result", async () => {
    mockRedis.multi.mockImplementationOnce(() => {
      const chain: Pipeline = {
        incrby: jest.fn(),
        expire: jest.fn(),
        exec: jest.fn(),
      }
      chain.incrby.mockReturnValue(chain)
      chain.expire.mockReturnValue(chain)
      chain.exec.mockResolvedValue(null)
      return chain
    })

    await expect(consumeGlobalBudget(1)).resolves.toBe(false)
  })

  it("uses the UTC date for the budget key (not the local date)", () => {
    // 2026-03-05T23:30:00-05:00 is already 2026-03-06 in UTC.
    const date = new Date("2026-03-05T23:30:00-05:00")
    expect(globalBudgetKey(date)).toBe("budget:llm:2026-03-06")
  })

  it("reads the max from the env schema (default 2000)", () => {
    expect(getGlobalDailyMax()).toBe(2000)

    env.GLOBAL_DAILY_LLM_CALLS_MAX = 500
    expect(getGlobalDailyMax()).toBe(500)
    // Invalid values (non-numeric, negative) are rejected at startup by the
    // schema instead of falling back here — see config.env.test.ts.
  })

  it("exposes consumed units on the rag_global_budget_used gauge", async () => {
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 100
    await consumeGlobalBudget(7)

    const metric = await globalBudgetUsed.get()
    expect(metric.values[0]?.value).toBe(7)
  })
})

describe("consumeVoiceBudget (Day 2 — 40% voice sub-cap)", () => {
  beforeEach(() => {
    mockRedisStore.clear()
    mockTtlStore.clear()
    mockRedisDown = false
    jest.clearAllMocks()
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 2000
  })

  it("sub-cap is 40% of the global max (default 2000 → 800)", () => {
    expect(VOICE_BUDGET_SHARE).toBe(0.4)
    expect(getVoiceDailyMax()).toBe(800)

    env.GLOBAL_DAILY_LLM_CALLS_MAX = 10
    expect(getVoiceDailyMax()).toBe(4) // floor(4)
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 7
    expect(getVoiceDailyMax()).toBe(2) // floor(2.8)
  })

  it("increments both the voice and the global budget keys with 48h TTLs", async () => {
    await expect(consumeVoiceBudget(3)).resolves.toBe(true)

    expect(mockRedisStore.get(globalBudgetKey())).toBe(3)
    expect(mockRedisStore.get(voiceBudgetKey())).toBe(3)
    expect(mockTtlStore.get(voiceBudgetKey())).toBe(48 * 60 * 60)
  })

  it("refused by the voice sub-cap leaves the GLOBAL counter unchanged", async () => {
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 100 // voice cap = 40

    await expect(consumeVoiceBudget(40)).resolves.toBe(true) // exactly at sub-cap
    await expect(consumeVoiceBudget(1)).resolves.toBe(false) // voice 41 > 40

    // Check-before-increment: a refused voice call must not drain the
    // shared budget — otherwise a refused flood defeats the sub-cap.
    expect(mockRedisStore.get(globalBudgetKey())).toBe(40)
    expect(mockRedisStore.get(voiceBudgetKey())).toBe(40)
  })

  it("keeps text working after voice is locked out (the point of the sub-cap)", async () => {
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 100

    await expect(consumeVoiceBudget(40)).resolves.toBe(true) // voice at its cap
    await expect(consumeVoiceBudget(1)).resolves.toBe(false) // refused, nothing changes
    await expect(consumeGlobalBudget(59)).resolves.toBe(true) // text: 99 ≤ 100
    await expect(consumeVoiceBudget(1)).resolves.toBe(false) // voice still at cap
  })

  it("refused by the global cap also writes nothing", async () => {
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 10 // voice cap = 4

    await consumeGlobalBudget(7) // text took 7 of 10
    await expect(consumeVoiceBudget(4)).resolves.toBe(false) // 7 + 4 = 11 > 10

    expect(mockRedisStore.get(globalBudgetKey())).toBe(7) // unchanged
    expect(mockRedisStore.get(voiceBudgetKey())).toBeUndefined() // never written
  })

  it("fails closed when Redis is unavailable", async () => {
    mockRedisDown = true
    await expect(consumeVoiceBudget(1)).resolves.toBe(false)
  })

  it("fails closed when the script returns no result", async () => {
    mockRedis.eval.mockImplementationOnce(async () => null)

    await expect(consumeVoiceBudget(1)).resolves.toBe(false)
  })

  it("uses the UTC date for the voice key (not the local date)", () => {
    const date = new Date("2026-03-05T23:30:00-05:00")
    expect(voiceBudgetKey(date)).toBe("budget:voice:2026-03-06")
  })

  it("updates the rag_global_budget_used gauge with the global total", async () => {
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 100
    await consumeVoiceBudget(7)
    const metric = await globalBudgetUsed.get()
    expect(metric.values[0]?.value).toBe(7)
  })
})

describe("HTTP wiring: 503 when the budget is exhausted", () => {
  let server: import("http").Server
  let baseUrl: string

  beforeAll(async () => {
    const express = require("express") as typeof import("express")
    const app = express()
    app.use(express.json())
    const controller = new EvalController()
    app.post("/score", (req, res, next) => {
      void controller.score(req, res, next)
    })

    await new Promise<void>(resolve => {
      server = app.listen(0, () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new Error("Could not determine test server port")
    }
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  beforeEach(() => {
    mockRedisStore.clear()
    mockRedisDown = false
    jest.clearAllMocks()
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 2000
  })

  const validBody = JSON.stringify({
    query: "What are the risks?",
    retrievedContext: ["Risk A", "Risk B"],
    answer: "The main risk is A.",
  })

  const postScore = async (): Promise<Response> =>
    fetch(`${baseUrl}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody,
    })

  it("returns 503 with the exact capacity message when the budget fails closed", async () => {
    mockRedisDown = true

    const res = await postScore()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      success: false,
      error: "Daily capacity reached, try again tomorrow",
    })
    expect(mockEvaluate).not.toHaveBeenCalled()
  })

  it("returns 503 with the exact capacity message when the budget is over the max", async () => {
    env.GLOBAL_DAILY_LLM_CALLS_MAX = 2

    // First call: 3 units > 2 ⇒ refused.
    const res = await postScore()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      success: false,
      error: "Daily capacity reached, try again tomorrow",
    })
    expect(mockEvaluate).not.toHaveBeenCalled()
  })

  it("passes through to the evaluator while the budget has room", async () => {
    const res = await postScore()
    expect(res.status).toBe(200)
    expect(mockEvaluate).toHaveBeenCalledTimes(1)
    const body = (await res.json()) as { success: boolean; data: { overallScore: number } }
    expect(body.success).toBe(true)
    expect(body.data.overallScore).toBe(0.9)
  })
})

export {}
