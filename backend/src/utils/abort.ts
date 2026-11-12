// backend/src/utils/abort.ts
// Cancellation + timeouts for outbound Gemini calls (task 2.9, D15).

import { env } from "../config/env"

// Per-call ceiling: a single Gemini request may never hang longer than this.
// The value is a safety net for the whole call, not the agent run as a
// whole — a run makes many calls, each individually bounded.
export const GEMINI_TIMEOUT_MS = env.GEMINI_TIMEOUT_MS

/**
 * Combine an optional caller signal with a per-call timeout.
 *
 * - No caller signal → the timeout signal alone.
 * - Caller signal → `AbortSignal.any([signal, timeout])`, so the call is
 *   cancelled when EITHER the caller aborts OR the timeout fires.
 *
 * Requires Node 20.3+ (AbortSignal.any / AbortSignal.timeout).
 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * True when an error is the cancellation raised by an aborted fetch.
 *
 * User aborts surface as DOMException "AbortError"; a withTimeout expiry
 * surfaces as "TimeoutError" — callers that distinguish "user cancelled"
 * from "call failed" must check `signal.aborted` as well (a timeout is a
 * failure, a user abort is not).
 *
 * Checks `name` rather than `instanceof Error` — DOMException does not
 * reliably inherit from Error across JS realms (it does not in the Jest
 * sandbox), and the name check matches what undici/Node actually throw.
 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  )
}
