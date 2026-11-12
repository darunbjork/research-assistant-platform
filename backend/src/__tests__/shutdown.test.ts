// backend/src/__tests__/shutdown.test.ts
//
// Task 5.5 (D13): graceful shutdown — call order, once-only behaviour, the
// 25s fallback exit(1), signal wiring, and resilience to a failing step.
// Every dependency is mocked; nothing real is closed.

import type { Server } from "http"
import type { ShutdownDeps } from "../lifecycle/shutdown"

type ShutdownModule = typeof import("../lifecycle/shutdown")

// The module keeps a once-only flag in module state — reload it per test.
function loadModule(): ShutdownModule {
  jest.resetModules()
  return require("../lifecycle/shutdown") as ShutdownModule
}

interface Fixture {
  calls: string[]
  exit: jest.Mock<void, [code: number]>
  deps: ShutdownDeps
  /** Value of isShuttingDown() observed inside httpServer.close(). */
  flagAtClose: () => boolean | undefined
  mocks: {
    httpClose: jest.Mock
    abortAgents: jest.Mock
    closeWs: jest.Mock
    closeQueue: jest.Mock
    disconnectDatabase: jest.Mock
    quitRedis: jest.Mock
    shutdownTracing: jest.Mock
  }
}

function makeFixture(options: { hangLabel?: string; failingLabel?: string } = {}): Fixture {
  const calls: string[] = []
  let flagAtClose: boolean | undefined

  const step = (label: string): Promise<void> => {
    calls.push(label)
    if (options.hangLabel === label) {
      return new Promise<never>(() => undefined) // never settles
    }
    if (options.failingLabel === label) {
      return Promise.reject(new Error(`${label} exploded`))
    }
    return Promise.resolve()
  }

  const exit = jest.fn((code: number): void => {
    calls.push(`exit:${code}`)
  })

  const mocks = {
    httpClose: jest.fn(() => {
      calls.push("httpServer.close")
      flagAtClose = undefined // set by the runner's module via closure below
      return undefined
    }),
    abortAgents: jest.fn(() => calls.push("abortRunningAgents")),
    closeWs: jest.fn(() => calls.push("closeAllWsClients")),
    closeQueue: jest.fn(() => step("closeQueue")),
    disconnectDatabase: jest.fn(() => step("disconnectDatabase")),
    quitRedis: jest.fn(() => step("quitRedis")),
    shutdownTracing: jest.fn(() => step("shutdownTracing")),
  }

  const deps: ShutdownDeps = {
    httpServer: { close: mocks.httpClose } as unknown as Pick<Server, "close">,
    abortRunningAgents: mocks.abortAgents as () => void,
    closeAllWsClients: mocks.closeWs as () => void,
    closeQueue: mocks.closeQueue as () => Promise<void>,
    disconnectDatabase: mocks.disconnectDatabase as () => Promise<void>,
    quitRedis: mocks.quitRedis as () => Promise<void>,
    shutdownTracing: mocks.shutdownTracing as () => Promise<void>,
    exit,
    fallbackMs: 40,
  }

  return {
    calls,
    exit,
    deps,
    flagAtClose: () => flagAtClose,
    mocks,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out")
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe("graceful shutdown (task 5.5 / D13)", () => {
  it("runs the teardown sequence in the planned order", async () => {
    const mod = loadModule()
    const fixture = makeFixture()
    expect(mod.isShuttingDown()).toBe(false)

    const runner = mod.createShutdown(fixture.deps)
    await runner.shutdown()

    expect(fixture.calls).toEqual([
      "httpServer.close",
      "abortRunningAgents",
      "closeAllWsClients",
      "closeQueue",
      "disconnectDatabase",
      "quitRedis",
      "shutdownTracing",
      "exit:0",
    ])
    expect(mod.isShuttingDown()).toBe(true)
  })

  it("sets the shutting-down flag before httpServer.close() (health flips to 503 first)", async () => {
    const mod = loadModule()
    const fixture = makeFixture()

    // Observe the flag from inside step 2 itself.
    let flagDuringClose: boolean | undefined
    fixture.mocks.httpClose.mockImplementation(() => {
      fixture.calls.push("httpServer.close")
      flagDuringClose = mod.isShuttingDown()
      return undefined
    })

    await mod.createShutdown(fixture.deps).shutdown()

    expect(flagDuringClose).toBe(true)
  })

  it("runs only once, even when called concurrently", async () => {
    const mod = loadModule()
    const fixture = makeFixture()
    const runner = mod.createShutdown(fixture.deps)

    await Promise.all([runner.shutdown(), runner.shutdown()])
    await runner.shutdown()

    expect(fixture.mocks.httpClose).toHaveBeenCalledTimes(1)
    expect(fixture.mocks.abortAgents).toHaveBeenCalledTimes(1)
    expect(fixture.mocks.closeWs).toHaveBeenCalledTimes(1)
    expect(fixture.mocks.closeQueue).toHaveBeenCalledTimes(1)
    expect(fixture.mocks.disconnectDatabase).toHaveBeenCalledTimes(1)
    expect(fixture.mocks.quitRedis).toHaveBeenCalledTimes(1)
    expect(fixture.mocks.shutdownTracing).toHaveBeenCalledTimes(1)
    expect(fixture.exit).toHaveBeenCalledTimes(1)
    expect(fixture.exit).toHaveBeenCalledWith(0)
  })

  it("force-exits with code 1 when a step hangs past the fallback", async () => {
    const mod = loadModule()
    const fixture = makeFixture({ hangLabel: "closeQueue" })

    const runner = mod.createShutdown(fixture.deps)
    void runner.shutdown() // never resolves — closeQueue hangs

    await waitFor(() => fixture.exit.mock.calls.length > 0)

    expect(fixture.exit).toHaveBeenCalledWith(1)
    // Steps behind the hang must not have run.
    expect(fixture.calls).not.toContain("disconnectDatabase")
    expect(fixture.calls).not.toContain("shutdownTracing")
  })

  it("continues past a failing step and still exits 0", async () => {
    const mod = loadModule()
    const fixture = makeFixture({ failingLabel: "quitRedis" })

    await mod.createShutdown(fixture.deps).shutdown()

    expect(fixture.calls).toEqual([
      "httpServer.close",
      "abortRunningAgents",
      "closeAllWsClients",
      "closeQueue",
      "disconnectDatabase",
      "quitRedis",
      "shutdownTracing",
      "exit:0",
    ])
  })

  it("registerShutdown wires SIGTERM and SIGINT to the runner", async () => {
    const mod = loadModule()
    const fixture = makeFixture()
    const runner = mod.createShutdown(fixture.deps)

    const onceSpy = jest.spyOn(process, "once")
    try {
      mod.registerShutdown(runner)

      const listeners = new Map<unknown, unknown>()
      for (const [signal, listener] of onceSpy.mock.calls) {
        listeners.set(signal, listener)
      }
      expect(typeof listeners.get("SIGTERM")).toBe("function")
      expect(typeof listeners.get("SIGINT")).toBe("function")
      ;(listeners.get("SIGTERM") as () => void)()
      await waitFor(() => fixture.exit.mock.calls.length > 0)
      expect(fixture.exit).toHaveBeenCalledWith(0)
    } finally {
      onceSpy.mockRestore()
    }
  })
})
