// backend/src/services/tts.service.ts
//
// Text-to-speech provider boundary. Mirrors stt.service.ts: one interface,
// a deterministic mock (silence sized from the text, no network) and the
// real ElevenLabs streaming client. The provider is chosen by TTS_PROVIDER,
// which is independent of VOICE_MOCK (that flag controls speech-to-text only).
//
// Audio contract: PCM16 little-endian mono at TTS_SAMPLE_RATE (24 kHz), in
// chunks of an even byte length (never a split sample) of at most 8 KB.

import { setImmediate as nextTick } from "node:timers/promises"
import { TTS_SAMPLE_RATE } from "../types/voice.types"
import { CircuitBreaker, CircuitOpenError } from "../utils/circuit-breaker"
import { RateLimitError } from "../middleware/error.middleware"
import { withTimeout } from "../utils/abort"
import { logger } from "../utils/logger"
import { env } from "../config/env"

export interface TtsSynthesizeRequest {
  text: string
  sessionId: string
}

export interface TtsSynthesizeResult {
  /** PCM16 little-endian mono audio at TTS_SAMPLE_RATE. */
  audioPcm16: Buffer
}

export interface TtsService {
  /**
   * Stream PCM16 LE mono audio for `request.text`. Chunks have an even byte
   * length of at most TTS_MAX_CHUNK_BYTES. Aborting `signal` stops the
   * stream (no further upstream reads).
   */
  synthesizeStream(request: TtsSynthesizeRequest, signal: AbortSignal): AsyncIterable<Buffer>
}

/** Largest audio chunk handed to the caller (one WS binary frame). */
export const TTS_MAX_CHUNK_BYTES = 8192
/** Mock chunk size — small enough that barge-in lands mid-stream in tests. */
const MOCK_CHUNK_BYTES = 4096
/** ElevenLabs must start sending audio within this window. */
export const TTS_FIRST_BYTE_TIMEOUT_MS = 10_000
/** Hard ceiling for one whole synthesis (600 chars streams far faster). */
const TTS_TOTAL_TIMEOUT_MS = 60_000

export type TtsErrorCode = "TTS_AUTH" | "TTS_QUOTA" | "TTS_UNAVAILABLE" | "TTS_FAILED"

/** Provider failure with a machine-readable code (never carries the text or key). */
export class TtsError extends Error {
  constructor(
    readonly code: TtsErrorCode,
    message: string,
    readonly status?: number,
    /** ElevenLabs' own error code (e.g. "paid_plan_required") — safe to log. */
    readonly providerCode?: string
  ) {
    super(message)
    this.name = "TtsError"
  }
}

/** Deterministic mock: ~10 ms of silence per character, no network. */
export class MockTtsService implements TtsService {
  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const durationMs = request.text.length * 10
    const samples = Math.round((durationMs / 1000) * TTS_SAMPLE_RATE)
    return { audioPcm16: Buffer.alloc(samples * 2) }
  }

  async *synthesizeStream(
    request: TtsSynthesizeRequest,
    signal: AbortSignal
  ): AsyncIterable<Buffer> {
    const { audioPcm16 } = await this.synthesize(request)
    for (let offset = 0; offset < audioPcm16.length; offset += MOCK_CHUNK_BYTES) {
      // Yield to the event loop so barge-in / close can abort mid-stream.
      await nextTick()
      if (signal.aborted) return
      yield audioPcm16.subarray(offset, offset + MOCK_CHUNK_BYTES)
    }
  }
}

/**
 * Re-chunk an arbitrary byte stream into even-length chunks of at most
 * `maxBytes`. A trailing odd byte (half a sample) is dropped — playing it
 * would crackle.
 */
export async function* evenChunks(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number = TTS_MAX_CHUNK_BYTES
): AsyncIterable<Buffer> {
  let pending = Buffer.alloc(0)
  for await (const piece of source) {
    pending = pending.length === 0 ? Buffer.from(piece) : Buffer.concat([pending, piece])
    // Emit everything usable now (keeps latency low); hold back an odd byte.
    while (pending.length >= 2) {
      const size = Math.min(maxBytes, pending.length - (pending.length % 2))
      yield pending.subarray(0, size)
      pending = pending.subarray(size)
    }
  }
}

export interface ElevenLabsConfig {
  apiKey: string
  voiceId: string
  modelId: string
  outputFormat: string
  /** Overridable for tests. */
  baseUrl?: string
  firstByteTimeoutMs?: number
}

/** ElevenLabs error body: `{ detail: { code, status, message } }` (code/status are safe to log). */
function providerErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { detail?: { code?: unknown; status?: unknown } }
    const code = parsed.detail?.code ?? parsed.detail?.status
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

/** Map a non-OK ElevenLabs response to a typed error (body is read, never logged). */
async function errorFromResponse(response: Response): Promise<Error> {
  const status = response.status
  const body = await response.text().catch(() => "")
  const providerCode = providerErrorCode(body)

  // A setup problem, not a spent cap: free plans cannot use library voices
  // via the API (HTTP 402 paid_plan_required). Retrying cannot fix it, so it
  // must not read as "quota" or trip the breaker.
  if (providerCode === "paid_plan_required") {
    return new TtsError(
      "TTS_FAILED",
      "The configured voice needs a paid ElevenLabs plan — choose a default voice.",
      status,
      providerCode
    )
  }
  if (providerCode === "quota_exceeded" || status === 402 || /quota/i.test(body)) {
    return new TtsError(
      "TTS_QUOTA",
      "Speech quota reached — spoken answers resume when it resets.",
      status,
      providerCode
    )
  }
  if (status === 401 || status === 403) {
    return new TtsError(
      "TTS_AUTH",
      "Speech provider rejected the server credentials.",
      status,
      providerCode
    )
  }
  if (status === 429) {
    return new RateLimitError("Speech provider rate-limited the request — try again shortly.")
  }
  if (status >= 500) {
    return new TtsError(
      "TTS_UNAVAILABLE",
      `Speech provider unavailable (HTTP ${status}).`,
      status,
      providerCode
    )
  }
  return new TtsError(
    "TTS_FAILED",
    `Speech provider refused the request (HTTP ${status}).`,
    status,
    providerCode
  )
}

/** Real ElevenLabs client: POST …/stream, PCM16 response body streamed through. */
export class ElevenLabsTtsService implements TtsService {
  private readonly baseUrl: string
  private readonly firstByteTimeoutMs: number

  constructor(private readonly config: ElevenLabsConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io"
    this.firstByteTimeoutMs = config.firstByteTimeoutMs ?? TTS_FIRST_BYTE_TIMEOUT_MS
  }

  async *synthesizeStream(
    request: TtsSynthesizeRequest,
    signal: AbortSignal
  ): AsyncIterable<Buffer> {
    const startedAt = Date.now()
    const voice = encodeURIComponent(this.config.voiceId)
    const format = encodeURIComponent(this.config.outputFormat)
    const url = `${this.baseUrl}/v1/text-to-speech/${voice}/stream?output_format=${format}`

    // First-byte watchdog: cleared as soon as audio starts flowing; the total
    // ceiling (withTimeout) still bounds the whole stream.
    const firstByte = new AbortController()
    const watchdog = setTimeout(() => firstByte.abort(), this.firstByteTimeoutMs)
    const requestSignal = AbortSignal.any([
      withTimeout(signal, TTS_TOTAL_TIMEOUT_MS),
      firstByte.signal,
    ])

    const fail = (error: unknown): Error => {
      if (signal.aborted) return error instanceof Error ? error : new Error(String(error))
      if (error instanceof TtsError || error instanceof RateLimitError) return error
      const reason = firstByte.signal.aborted
        ? "no audio within the first-byte timeout"
        : "network error"
      return new TtsError("TTS_UNAVAILABLE", `Speech provider unavailable (${reason}).`)
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let bytes = 0
    let firstByteMs: number | null = null
    try {
      let response: Response
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "audio/pcm",
            "xi-api-key": this.config.apiKey,
          },
          body: JSON.stringify({ text: request.text, model_id: this.config.modelId }),
          signal: requestSignal,
        })
      } catch (error: unknown) {
        throw fail(error)
      }
      if (!response.ok) throw await errorFromResponse(response)
      if (response.body === null) {
        throw new TtsError("TTS_UNAVAILABLE", "Speech provider returned no audio stream.")
      }

      const activeReader = response.body.getReader()
      reader = activeReader
      const upstream = async function* (): AsyncIterable<Uint8Array> {
        for (;;) {
          // Caller aborted (barge-in, new question, close): no further reads.
          if (signal.aborted) return
          let result: ReadableStreamReadResult<Uint8Array>
          try {
            result = await activeReader.read()
          } catch (error: unknown) {
            throw fail(error)
          }
          if (result.done) return
          if (firstByteMs === null) {
            firstByteMs = Date.now() - startedAt
            clearTimeout(watchdog)
          }
          yield result.value
        }
      }

      for await (const chunk of evenChunks(upstream())) {
        bytes += chunk.length
        yield chunk
      }
      if (signal.aborted) return

      logger.info("TTS stream complete", {
        service: "ElevenLabsTts",
        sessionId: request.sessionId,
        chars: request.text.length,
        bytes,
        durationMs: Date.now() - startedAt,
        firstByteMs,
      })
    } catch (error: unknown) {
      if (!signal.aborted) {
        logger.warn("TTS stream failed", {
          service: "ElevenLabsTts",
          sessionId: request.sessionId,
          chars: request.text.length,
          bytes,
          durationMs: Date.now() - startedAt,
          code: error instanceof TtsError ? error.code : (error as { code?: string }).code,
          status: error instanceof TtsError ? error.status : undefined,
          providerCode: error instanceof TtsError ? error.providerCode : undefined,
        })
      }
      throw error
    } finally {
      clearTimeout(watchdog)
      // Early return / abort: stop pulling from ElevenLabs immediately.
      await reader?.cancel().catch(() => undefined)
    }
  }
}

/**
 * Guard a TTS service with a circuit breaker. Outages (TTS_UNAVAILABLE)
 * count toward the threshold; a quota response trips it open at once;
 * auth, rate-limit and caller aborts are not outages and never count.
 */
export function withTtsBreaker(inner: TtsService, breaker: CircuitBreaker): TtsService {
  return {
    async *synthesizeStream(request, signal): AsyncIterable<Buffer> {
      if (!breaker.isAvailable()) throw new CircuitOpenError(breaker.name)
      try {
        yield* inner.synthesizeStream(request, signal)
        if (!signal.aborted) breaker.recordSuccess()
      } catch (error: unknown) {
        if (!signal.aborted && error instanceof TtsError) {
          if (error.code === "TTS_QUOTA") breaker.tripOpen()
          else if (error.code === "TTS_UNAVAILABLE") breaker.recordFailure()
        }
        throw error
      }
    },
  }
}

/** Breaker guarding the ElevenLabs endpoint (trips → PROVIDER_UNAVAILABLE). */
export const ttsBreaker = new CircuitBreaker("elevenlabs-tts")

export type TtsProvider = "mock" | "elevenlabs"

/** Build the TTS service for a provider (env.TTS_PROVIDER). */
export function createTtsService(provider: TtsProvider, breaker?: CircuitBreaker): TtsService {
  let inner: TtsService
  if (provider === "elevenlabs") {
    if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
      // env.ts validates this at startup; guard keeps the types honest.
      throw new Error("ElevenLabs TTS needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID")
    }
    inner = new ElevenLabsTtsService({
      apiKey: env.ELEVENLABS_API_KEY,
      voiceId: env.ELEVENLABS_VOICE_ID,
      modelId: env.ELEVENLABS_MODEL_ID,
      outputFormat: env.ELEVENLABS_OUTPUT_FORMAT,
    })
  } else {
    inner = new MockTtsService()
  }
  return breaker ? withTtsBreaker(inner, breaker) : inner
}

let defaultTts: TtsService | null = null

/** Process-wide TTS service chosen from env.TTS_PROVIDER (lazy, memoised). */
export function getTtsService(): TtsService {
  defaultTts ??= createTtsService(env.TTS_PROVIDER, ttsBreaker)
  return defaultTts
}
