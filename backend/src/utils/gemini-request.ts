import { setTimeout as delay } from "node:timers/promises"
import { RateLimitError } from "../middleware/error.middleware"
import { withTimeout, GEMINI_TIMEOUT_MS } from "./abort"
import type { GeminiRequest, GeminiResponse } from "../types/llm.types"

/** Retry short provider throttles; leave quota resets and long waits to the user. */
export async function requestGemini(
  url: string,
  apiKey: string,
  body: GeminiRequest,
  signal?: AbortSignal
): Promise<GeminiResponse> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: withTimeout(signal, GEMINI_TIMEOUT_MS),
    })
    if (response.ok) return response.json() as Promise<GeminiResponse>
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
  throw new RateLimitError("Gemini is temporarily rate limited. Please try again shortly.")
}
