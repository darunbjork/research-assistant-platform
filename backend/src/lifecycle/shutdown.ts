// backend/src/lifecycle/shutdown.ts
//
// Task 5.5 (D13): ordered, once-only graceful shutdown for SIGTERM/SIGINT.
// Order matters:
//   1. shuttingDown flag   → /health returns 503, the proxy drains traffic
//   2. httpServer.close()  → stop accepting new connections
//   3. abort agent runs    → then close WS clients with 1001 (going away)
//   4. queue.close()       → Bull finishes active ingestion jobs
//   5. prisma / redis / tracing disconnects
//   6. exit(0); a fallback timer force-exits(1) if anything hangs.
// The fallback is 25s — under compose's stop_grace_period of 30s.

import type { Server } from "http"
import { logError } from "../utils/logger"

export const SHUTDOWN_FALLBACK_MS = 25_000

let shuttingDown = false

/** True once a shutdown has started — /health serves 503 while this holds. */
export function isShuttingDown(): boolean {
  return shuttingDown
}

/** Test-only: reset the module flag so each test gets a fresh shutdown. */
export function resetShutdownForTests(): void {
  shuttingDown = false
}

export interface ShutdownDeps {
  /** Minimal shape of http.Server — only close() is required. */
  httpServer: Pick<Server, "close">
  abortRunningAgents: () => void
  closeAllWsClients: () => void
  closeQueue: () => Promise<void>
  disconnectDatabase: () => Promise<void>
  quitRedis: () => Promise<void>
  shutdownTracing: () => Promise<void>
  /** Clears in-process timers (e.g. the daily transcript purge). */
  stopPeriodicTasks?: () => Promise<void>
  /** Injectable for tests; defaults to process.exit. */
  exit?: (code: number) => void
  /** Injectable for tests; defaults to SHUTDOWN_FALLBACK_MS. */
  fallbackMs?: number
}

export interface ShutdownRunner {
  /** Runs the shutdown sequence once; later calls are no-ops. */
  shutdown: () => Promise<void>
}

export function createShutdown(deps: ShutdownDeps): ShutdownRunner {
  const exit = deps.exit ?? ((code: number): void => process.exit(code))
  const fallbackMs = deps.fallbackMs ?? SHUTDOWN_FALLBACK_MS

  /** Log-and-continue: one failing teardown must not skip the others. */
  const attempt = async (label: string, step: () => Promise<void>): Promise<void> => {
    try {
      await step()
    } catch (error: unknown) {
      logError(`Shutdown step failed: ${label}`, error, { service: "Lifecycle" })
    }
  }

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true // 1. health flips to 503 before anything else happens

    // Fallback: force-exit(1) if any step hangs. Not unref'd — the timer is
    // what keeps the process alive while the steps below are pending.
    const fallback = setTimeout(() => {
      logError(
        `Shutdown did not finish within ${fallbackMs}ms — forcing exit(1)`,
        new Error("Shutdown fallback triggered"),
        { service: "Lifecycle" }
      )
      exit(1)
    }, fallbackMs)

    // 2. Stop accepting new connections (does not wait for in-flight ones —
    //    upgraded WS sockets would delay the callback until step 3 closes them).
    deps.httpServer.close()

    // 3. Abort in-flight agent runs, then say goodbye to every WS client.
    deps.abortRunningAgents()
    deps.closeAllWsClients()

    // 4. Bull waits for active ingestion jobs to finish.
    await attempt("closeQueue", deps.closeQueue)

    // 4b. Stop in-process timers (daily transcript purge) — nothing else
    // uses them past this point.
    if (deps.stopPeriodicTasks !== undefined) {
      await attempt("stopPeriodicTasks", deps.stopPeriodicTasks)
    }

    // 5. Disconnect dependencies.
    await attempt("disconnectDatabase", deps.disconnectDatabase)
    await attempt("quitRedis", deps.quitRedis)
    await attempt("shutdownTracing", deps.shutdownTracing)

    clearTimeout(fallback)
    exit(0)
  }

  return { shutdown }
}

/** Wire a runner to SIGTERM/SIGINT — once per signal, never twice. */
export function registerShutdown(runner: ShutdownRunner): void {
  const handle = (): void => {
    void runner.shutdown()
  }
  process.once("SIGTERM", handle)
  process.once("SIGINT", handle)
}
