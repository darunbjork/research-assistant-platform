import { setTimeout as delay } from "node:timers/promises"
import { env } from "../config/env"
import { RateLimitError } from "../middleware/error.middleware"
import { logger } from "./logger"
import { withTimeout, GEMINI_TIMEOUT_MS } from "./abort"
import type { GeminiRequest, GeminiResponse } from "../types/llm.types"

/** Provider-side overload / transient server errors worth retrying. */
const OVERLOAD_STATUSES = new Set([500, 502, 503, 504])
/** Waits before the 2nd and 3rd attempt on an overloaded model. */
const DEFAULT_OVERLOAD_DELAYS_MS = [1000, 3000]

/** The model stayed overloaded (5xx) or timed out after all retries. */
export class GeminiUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`Gemini is overloaded right now (${detail}). Please try again in a minute.`)
    this.name = "GeminiUnavailableError"
  }
}

export interface RequestGeminiOptions {
  /** Model tried once if the primary stays unavailable. Defaults to GEMINI_FALLBACK_MODEL. */
  fallbackModel?: string
  /** Override retry waits (tests). */
  overloadDelaysMs?: number[]
}

/**
 * POST a generateContent request with:
 * - 429: short throttles retried; quota resets and long waits surfaced to the user.
 * - 5xx: retried with backoff (Gemini returns 503 "high demand" under load).
 * - Primary still 5xx, timed out, or rate/quota limited → one pass on the fallback model, if configured.
 */
export async function requestGemini(
  url: string,
  apiKey: string,
  body: GeminiRequest,
  signal?: AbortSignal,
  options: RequestGeminiOptions = {}
): Promise<GeminiResponse> {
  const fallbackModel = options.fallbackModel ?? env.GEMINI_FALLBACK_MODEL
  const delays = options.overloadDelaysMs ?? DEFAULT_OVERLOAD_DELAYS_MS
  try {
    return await requestModel(url, apiKey, body, delays, signal)
  } catch (error: unknown) {
    const fallbackUrl = fallbackModel ? withModel(url, fallbackModel) : null
    // Free-tier rate limits and quotas are per model, so a throttled primary
    // does not mean the fallback is throttled too.
    const fallbackWorthy =
      error instanceof GeminiUnavailableError || error instanceof RateLimitError
    if (!fallbackWorthy || fallbackUrl === null || signal?.aborted) {
      throw error
    }
    logger.warn("Gemini primary model unavailable — using fallback model", {
      service: "GeminiRequest",
      detail: error instanceof GeminiUnavailableError ? error.detail : "rate or quota limit",
      fallbackModel,
    })
    return requestModel(fallbackUrl, apiKey, body, delays, signal)
  }
}

/** Swap the model segment of a `.../models/<model>:<method>` URL; null if absent or unchanged. */
function withModel(url: string, model: string): string | null {
  const swapped = url.replace(/\/models\/[^/:]+:/, `/models/${model}:`)
  return swapped === url ? null : swapped
}

async function requestModel(
  url: string,
  apiKey: string,
  body: GeminiRequest,
  overloadDelaysMs: number[],
  signal?: AbortSignal
): Promise<GeminiResponse> {
  let throttleAttempt = 0
  let overloadAttempt = 0
  for (;;) {
    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: withTimeout(signal, GEMINI_TIMEOUT_MS),
      })
    } catch (error: unknown) {
      // Per-call timeout (not a user abort): retrying the same overloaded model
      // would just wait again, so let the caller try the fallback.
      if (!signal?.aborted && (error as { name?: unknown })?.name === "TimeoutError") {
        throw new GeminiUnavailableError(`no response within ${GEMINI_TIMEOUT_MS / 1000}s`)
      }
      throw error
    }
    if (response.ok) return response.json() as Promise<GeminiResponse>

    if (OVERLOAD_STATUSES.has(response.status)) {
      if (overloadAttempt >= overloadDelaysMs.length) {
        throw new GeminiUnavailableError(`HTTP ${response.status}`)
      }
      await delay(overloadDelaysMs[overloadAttempt++], undefined, signal ? { signal } : undefined)
      continue
    }

    if (response.status !== 429) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`)
    }

    const errorBody = (await response.json().catch(() => null)) as {
      error?: { message?: string; details?: Array<{ retryDelay?: string }> }
    } | null
    const message = errorBody?.error?.message ?? ""
    if (/per.?day|daily|limit:\s*0\b/i.test(message)) {
      throw new RateLimitError(
        "Gemini quota is exhausted for this project or model. Check the project's Gemini API quota and try again after it resets."
      )
    }

    const attempt = throttleAttempt++
    const header = response.headers.get("retry-after")
    const retryDelay = errorBody?.error?.details?.find(detail => detail.retryDelay)?.retryDelay
    const seconds =
      header !== null
        ? /^\d+(\.\d+)?$/.test(header)
          ? Number(header)
          : (Date.parse(header) - Date.now()) / 1000
        : retryDelay
          ? Number.parseFloat(retryDelay)
          : 2 ** attempt
    const waitMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 1000 * 2 ** attempt
    if (attempt === 2 || waitMs > 10_000) {
      const wait = Math.max(1, Math.ceil(waitMs / 1000))
      throw new RateLimitError(
        `Gemini's rate or quota limit was reached. Try again in ${wait} seconds. If it continues, check the project's Gemini API quota.`
      )
    }
    await delay(waitMs, undefined, signal ? { signal } : undefined)
  }
}
