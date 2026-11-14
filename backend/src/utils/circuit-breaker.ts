// backend/src/utils/circuit-breaker.ts
//
// Per-provider circuit breaker (voice curriculum Day 2): after N consecutive
// failures the breaker OPENs and fails fast for cooldownMs, then admits one
// trial call (half-open). A successful trial CLOSEs it; a failed trial
// re-OPENs and restarts the cooldown. Used for Deepgram (Day 5) and
// ElevenLabs (Day 8) so an outage degrades to an immediate, typed refusal
// (CircuitOpenError → voice_error PROVIDER_UNAVAILABLE) instead of hammering
// a dead provider and paying for timeouts.
//
// In-process by design: one backend instance (ADR 0002 — single VPS), no
// Redis round-trip on the hot path. Each replica trips its own breaker —
// acceptable because the breaker is a latency/cost optimisation, not a
// correctness gate (the voice limiter and budget still bound usage
// globally).

export type CircuitState = "closed" | "open" | "half_open"

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. Default 5. */
  failureThreshold: number
  /** How long to stay open before a trial call is allowed. Default 5 min. */
  cooldownMs: number
  /** Clock injection for tests. Default Date.now. */
  now: () => number
}

/** Thrown when the breaker refuses a call (state open, or half-open busy). */
export class CircuitOpenError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE"
  readonly circuit: string

  constructor(circuit: string) {
    super(`Circuit "${circuit}" is open — provider unavailable`)
    this.name = "CircuitOpenError"
    this.circuit = circuit
  }
}

export class CircuitBreaker {
  readonly name: string
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private failures = 0
  private openedAt: number | null = null
  private trialInFlight = false

  constructor(name: string, options?: Partial<CircuitBreakerOptions>) {
    this.name = name
    this.failureThreshold = options?.failureThreshold ?? 5
    this.cooldownMs = options?.cooldownMs ?? 5 * 60_000
    this.now = options?.now ?? Date.now
  }

  get state(): CircuitState {
    if (this.openedAt === null) return "closed"
    if (this.now() - this.openedAt >= this.cooldownMs) return "half_open"
    return "open"
  }

  get consecutiveFailures(): number {
    return this.failures
  }

  /** True when a call would be attempted (state not fully open). */
  isAvailable(): boolean {
    return this.state !== "open"
  }

  /**
   * Run `fn` through the breaker. Rethrows the original error on failure
   * (callers log/handle their own provider errors); only the refusal to
   * even try is a CircuitOpenError.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state
    if (state === "open") {
      throw new CircuitOpenError(this.name)
    }
    if (state === "half_open") {
      // Exactly one trial call may be in flight; a second concurrent caller
      // is refused until the trial resolves (state transitions are
      // synchronous before the first await, so this cannot race).
      if (this.trialInFlight) {
        throw new CircuitOpenError(this.name)
      }
      this.trialInFlight = true
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    } finally {
      this.trialInFlight = false
    }
  }

  /**
   * Record one failure outside exec() — event-driven provider paths (Day 5
   * Deepgram handshake/stream failures arrive as WebSocket events, not as a
   * promise the breaker can wrap). Same semantics as exec's failure branch.
   */
  recordFailure(): void {
    this.onFailure()
  }

  /**
   * Record a success outside exec() (e.g. a handshake that connected).
   * Resets the consecutive-failure count and closes an open circuit.
   */
  recordSuccess(): void {
    this.onSuccess()
  }

  /**
   * Force the circuit OPEN now — used for provider quota signals (Deepgram
   * HTTP 402) where one response proves the cap is spent: fail fast instead
   * of burning the remaining failure budget on a condition that will not
   * heal within the cooldown (cost.md §5, Day 5 rule 3).
   */
  tripOpen(): void {
    this.failures = Math.max(this.failures, this.failureThreshold)
    if (this.openedAt === null) {
      this.openedAt = this.now()
    }
  }

  /** Test-only: return to a pristine closed state (mirrors resetShutdownForTests). */
  resetForTests(): void {
    this.failures = 0
    this.openedAt = null
    this.trialInFlight = false
  }

  private onSuccess(): void {
    this.failures = 0
    this.openedAt = null
  }

  private onFailure(): void {
    this.failures += 1
    const cooldownElapsed = this.openedAt !== null && this.now() - this.openedAt >= this.cooldownMs
    // Trip from closed at the threshold; a failed half-open trial always
    // re-opens with a fresh cooldown regardless of the count.
    if (cooldownElapsed || this.failures >= this.failureThreshold) {
      this.openedAt = this.now()
    }
  }
}
