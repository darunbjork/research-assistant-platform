// backend/src/__tests__/utils.circuit-breaker.test.ts
//
// Day 2: the provider circuit breaker must trip after N consecutive
// failures, fail fast while open, allow exactly one trial after the
// cooldown, and reset on a successful trial — with an injectable clock so
// no test waits on real time.

import { CircuitBreaker, CircuitOpenError } from "../utils/circuit-breaker"

describe("CircuitBreaker", () => {
  let now = 0
  const makeBreaker = (failureThreshold = 5, cooldownMs = 300_000): CircuitBreaker =>
    new CircuitBreaker("test-circuit", { failureThreshold, cooldownMs, now: () => now })

  beforeEach(() => {
    now = 0
  })

  it("starts closed and passes calls through", async () => {
    const breaker = makeBreaker()
    expect(breaker.state).toBe("closed")
    await expect(breaker.exec(async () => 42)).resolves.toBe(42)
    expect(breaker.consecutiveFailures).toBe(0)
  })

  it("rethrows the original provider error and counts one failure", async () => {
    const breaker = makeBreaker()
    const boom = new Error("provider 500")
    await expect(
      breaker.exec(async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(breaker.state).toBe("closed")
    expect(breaker.consecutiveFailures).toBe(1)
  })

  it("counts consecutive failures only — a success resets the count", async () => {
    const breaker = makeBreaker(3, 1000)
    const fail = (): Promise<never> =>
      breaker.exec(async () => {
        throw new Error("x")
      })

    await expect(fail()).rejects.toThrow()
    await expect(fail()).rejects.toThrow()
    await expect(breaker.exec(async () => "ok")).resolves.toBe("ok")
    expect(breaker.consecutiveFailures).toBe(0)

    // Two more failures — still below the threshold of 3.
    await expect(fail()).rejects.toThrow()
    await expect(fail()).rejects.toThrow()
    expect(breaker.state).toBe("closed")
  })

  it("opens at the threshold and refuses without calling fn", async () => {
    const breaker = makeBreaker(3, 1000)
    for (let i = 0; i < 3; i++) {
      await expect(
        breaker.exec(async () => {
          throw new Error("x")
        })
      ).rejects.toThrow()
    }
    expect(breaker.state).toBe("open")

    const fn = jest.fn(async () => "never")
    await expect(breaker.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(fn).not.toHaveBeenCalled()
  })

  it("half-opens after the cooldown; a successful trial closes it", async () => {
    const breaker = makeBreaker(2, 1000)
    for (let i = 0; i < 2; i++) {
      await expect(
        breaker.exec(async () => {
          throw new Error("x")
        })
      ).rejects.toThrow()
    }
    expect(breaker.state).toBe("open")

    now = 1000
    expect(breaker.state).toBe("half_open")
    await expect(breaker.exec(async () => "recovered")).resolves.toBe("recovered")
    expect(breaker.state).toBe("closed")
    await expect(breaker.exec(async () => "again")).resolves.toBe("again")
  })

  it("a failed half-open trial re-opens with a fresh cooldown", async () => {
    const breaker = makeBreaker(2, 1000)
    for (let i = 0; i < 2; i++) {
      await expect(
        breaker.exec(async () => {
          throw new Error("x")
        })
      ).rejects.toThrow()
    }

    now = 1000 // first cooldown elapses → half_open
    await expect(
      breaker.exec(async () => {
        throw new Error("still dead")
      })
    ).rejects.toThrow("still dead")
    expect(breaker.state).toBe("open") // reopened at t=1000

    now = 1500 // only 500 ms into the NEW cooldown
    expect(breaker.state).toBe("open")
    now = 2000 // full cooldown since the reopen
    expect(breaker.state).toBe("half_open")
  })

  it("refuses a concurrent second call while a half-open trial is in flight", async () => {
    const breaker = makeBreaker(1, 1000)
    await expect(
      breaker.exec(async () => {
        throw new Error("x")
      })
    ).rejects.toThrow()

    now = 1000
    let release: (value: string) => void = () => undefined
    const trial = breaker.exec(
      () =>
        new Promise<string>(resolve => {
          release = resolve
        })
    )

    await expect(breaker.exec(async () => "second")).rejects.toBeInstanceOf(CircuitOpenError)

    release("done")
    await expect(trial).resolves.toBe("done")
    expect(breaker.state).toBe("closed")
  })

  it("refusals carry the circuit name and PROVIDER_UNAVAILABLE code", async () => {
    const breaker = makeBreaker(1, 1000)
    await expect(
      breaker.exec(async () => {
        throw new Error("x")
      })
    ).rejects.toThrow()

    now = 100
    let caught: unknown = null
    try {
      await breaker.exec(async () => "nope")
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CircuitOpenError)
    const open = caught as CircuitOpenError
    expect(open.code).toBe("PROVIDER_UNAVAILABLE")
    expect(open.circuit).toBe("test-circuit")
    expect(open.message).toContain("test-circuit")
  })

  it("defaults to 5 failures and a 5-minute cooldown", () => {
    const breaker = new CircuitBreaker("defaults")
    expect(breaker.state).toBe("closed")
    expect(breaker.consecutiveFailures).toBe(0)

    // Trip synchronously: opening only needs the threshold, not elapsed time.
    const fail = (): Promise<never> =>
      breaker.exec(async () => {
        throw new Error("x")
      })
    void fail().catch(() => undefined)
    void fail().catch(() => undefined)
    void fail().catch(() => undefined)
    void fail().catch(() => undefined)
    const fifth = fail()
    return expect(fifth)
      .rejects.toThrow()
      .then(() => {
        expect(breaker.state).toBe("open")
      })
  })
})
