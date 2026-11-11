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
    let incCount = 0
    const pipeline: Pipeline = {
      incrby: jest.fn(),
      expire: jest.fn(),
      exec: jest.fn(),
    }
    pipeline.incrby.mockImplementation((key: string, by: number) => {
      const next = (mockRedisStore.get(key) ?? 0) + by
      mockRedisStore.set(key, next)
      incCount = next
      return pipeline
    })
    pipeline.expire.mockImplementation((key: string, seconds: number, nx?: string) => {
      if (nx === "NX" && mockTtlStore.has(key)) {
        return pipeline
      }
      mockTtlStore.set(key, seconds)
      return pipeline
    })
    pipeline.exec.mockImplementation(async () => [
      [null, incCount],
      [null, 1],
    ])
    return pipeline
  }),
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
const { consumeGlobalBudget, getGlobalDailyMax, globalBudgetKey } =
  require("../utils/global-budget") as typeof import("../utils/global-budget")
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
