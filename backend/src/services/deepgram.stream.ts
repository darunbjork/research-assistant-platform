// backend/src/services/deepgram.stream.ts
//
// Deepgram live-streaming STT client (voice curriculum Day 5). Verification
// is MOCK-ONLY: every test runs against a local fake WebSocket server; the
// real endpoint is only reached when VOICE_MOCK=false with a human-approved
// key (docs/cost.md §5 — no real call until the spend cap is confirmed).
//
// Protocol references (checked against current Deepgram docs, 2026-11-14):
//   - developers.deepgram.com/reference/speech-to-text/listen-streaming
//       Client messages: Media (binary), Finalize, CloseStream, KeepAlive,
//       Configure. Server messages: Results, Metadata, UtteranceEnd,
//       SpeechStarted, Error, ConfigureSuccess/Failure. The ListenV1Media
//       schema is `format: binary` — audio goes up as raw binary frames.
//   - developers.deepgram.com/docs/authenticating
//       `Authorization: Token <key>` (Token scheme, not Bearer), HTTPS only.
//   - developers.deepgram.com/docs/audio-keep-alive
//       `{"type":"KeepAlive"}` every 3–5 s of silence, sent as a TEXT frame
//       (binary keep-alives may break the parser); prevents the server's
//       ~10 s NET-0001 idle timeout.
//   - developers.deepgram.com/docs/close-stream
//       CloseStream → the server finishes cached data, sends final
//       responses, then terminates the socket.
//   - developers.deepgram.com/docs/finalize
//       `{"type":"Finalize"}` flushes; the flushed result carries
//       `from_finalize: true`.
//
// Interim transcripts are never requested (interim_results=false), never
// logged and never persisted. Exactly one final per utterance is delivered
// (onFinal) — either when the Finalize flush responds or, if the flush
// stalls but earlier finals exist, at the Finalize timeout.

import WebSocket, { type RawData } from "ws"
import type { IncomingMessage } from "http"
import { VOICE_SAMPLE_RATE } from "../types/voice.types"

// ── Defaults (docs: keep-alive every 3–5 s; the rest are safety bounds) ───
const DEFAULT_KEEP_ALIVE_MS = 4_000
const DEFAULT_KEEP_ALIVE_QUIET_MS = 3_000
const DEFAULT_FINALIZE_TIMEOUT_MS = 5_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
/** Backpressure bound: refuse to queue more than this behind a stalled socket. */
const DEFAULT_BUFFER_CAP_BYTES = 256 * 1024

// ── Handshake classification (cost.md §5, Day 5 rule 3) ───────────────────

/**
 * What a handshake outcome means for the breaker:
 *   - "count":  reachability problems (5xx, DNS, refused, timeout) — an
 *               outage; counts toward the failure threshold.
 *   - "ignore": other 4xx (401 bad key, 429 rate limit, 400 bad params) —
 *               a client-side condition, not an outage; never counted.
 *   - "quota":  HTTP 402 — the provider cap is spent; opens the breaker
 *               immediately and surfaces VOICE_BUDGET_REACHED.
 */
export type HandshakeOutcome = "count" | "ignore" | "quota"

export function classifyHandshakeStatus(status: number | null): HandshakeOutcome {
  if (status === null) return "count"
  if (status === 402) return "quota"
  if (status >= 400 && status < 500) return "ignore"
  return "count"
}

/** Rejected handshake carrying the HTTP status (null for network/timeout). */
export class DeepgramHandshakeError extends Error {
  readonly status: number | null

  constructor(status: number | null, message: string) {
    super(message)
    this.name = "DeepgramHandshakeError"
    this.status = status
  }
}

// ── Stream failure reporting ──────────────────────────────────────────────

/**
 * "count":  outages (socket drop, backpressure stall, Finalize timeout with
 *           no transcript) — the breaker records a failure.
 * "ignore": Deepgram `Error` frames — documented as non-fatal (fatal
 *           failures close the socket instead), so they surface to the user
 *           but must not trip the breaker.
 */
export type StreamFailureAction = "count" | "ignore"

export interface DeepgramStreamFailure {
  action: StreamFailureAction
  message: string
}

// ── URL builder ───────────────────────────────────────────────────────────

/**
 * Full listen URL: caller supplies the base (env.DEEPGRAM_WS_URL, overridable
 * for the fake-server tests); we pin the audio contract — raw PCM16 at
 * VOICE_SAMPLE_RATE, finals only (no interims to log or persist), smart
 * formatting for the final text.
 */
export function buildListenUrl(baseUrl: string, model: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set("encoding", "linear16")
  url.searchParams.set("sample_rate", String(VOICE_SAMPLE_RATE))
  url.searchParams.set("channels", "1")
  url.searchParams.set("model", model)
  url.searchParams.set("interim_results", "false")
  url.searchParams.set("smart_format", "true")
  return url.toString()
}

// ── Per-user upstream registry (one live stream per user) ─────────────────
// A new voice connection from the same user closes the old upstream stream
// and tells the old connection to tear its session down (Day 5 rule 2).

export interface UpstreamRegistration {
  stream: DeepgramStream
  /** Invoked on the DISPLACED owner when a newer connection takes over. */
  superseded: () => void
}

const upstreamsByUser = new Map<string, UpstreamRegistration>()

/**
 * Claim the upstream slot for `userId`. Returns the displaced registration
 * (if any) so the caller can close it and notify its owner.
 */
export function registerUpstream(
  userId: string,
  registration: UpstreamRegistration
): UpstreamRegistration | null {
  const displaced = upstreamsByUser.get(userId) ?? null
  upstreamsByUser.set(userId, registration)
  return displaced
}

/** Drop the slot only if it still belongs to `stream` (guarded delete). */
export function unregisterUpstream(userId: string, stream: DeepgramStream): void {
  const current = upstreamsByUser.get(userId)
  if (current !== undefined && current.stream === stream) {
    upstreamsByUser.delete(userId)
  }
}

/** Shutdown path: CloseStream + close on every live upstream (rule 2). */
export function closeAllVoiceUpstreams(): void {
  for (const registration of upstreamsByUser.values()) {
    registration.stream.close()
  }
  upstreamsByUser.clear()
}

// ── The stream ────────────────────────────────────────────────────────────

export interface DeepgramStreamOptions {
  /** Full listen URL (use buildListenUrl). */
  url: string
  apiKey: string
  /** For log context only — never logged with the key. */
  sessionId: string
  /** At most one final transcript per utterance (deliver-once). */
  onFinal: (text: string, fromFinalize: boolean) => void
  onFailure: (failure: DeepgramStreamFailure) => void
  // Test hooks — defaults match production behaviour.
  now?: () => number
  keepAliveMs?: number
  keepAliveQuietMs?: number
  finalizeTimeoutMs?: number
  handshakeTimeoutMs?: number
  bufferCapBytes?: number
  getBufferedAmount?: () => number
}

type StreamState = "idle" | "connecting" | "open" | "closed"

export class DeepgramStream {
  private readonly url: string
  private readonly apiKey: string
  private readonly sessionId: string
  private readonly onFinal: (text: string, fromFinalize: boolean) => void
  private readonly onFailure: (failure: DeepgramStreamFailure) => void
  private readonly now: () => number
  private readonly keepAliveMs: number
  private readonly keepAliveQuietMs: number
  private readonly finalizeTimeoutMs: number
  private readonly handshakeTimeoutMs: number
  private readonly bufferCapBytes: number
  private readonly getBufferedAmount: () => number

  private ws: WebSocket | null = null
  private state: StreamState = "idle"
  /** True once WE initiated the close — the close event is not a drop. */
  private closedByUs = false
  private failureReported = false

  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null
  private finalizePromise: Promise<string | null> | null = null
  private resolveFinal: ((text: string | null) => void) | null = null
  private awaitingFinal = false

  private lastAudioSentAtMs = 0
  private finalText: string | null = null
  private delivered = false

  constructor(options: DeepgramStreamOptions) {
    this.url = options.url
    this.apiKey = options.apiKey
    this.sessionId = options.sessionId
    this.onFinal = options.onFinal
    this.onFailure = options.onFailure
    this.now = options.now ?? Date.now
    this.keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS
    this.keepAliveQuietMs = options.keepAliveQuietMs ?? DEFAULT_KEEP_ALIVE_QUIET_MS
    this.finalizeTimeoutMs = options.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.bufferCapBytes = options.bufferCapBytes ?? DEFAULT_BUFFER_CAP_BYTES
    this.getBufferedAmount =
      options.getBufferedAmount ?? ((): number => this.ws?.bufferedAmount ?? 0)
  }

  get isOpen(): boolean {
    return this.state === "open"
  }

  /**
   * Open the WebSocket. The Authorization header carries the key (Token
   * scheme — docs/authenticating) and nothing else does. Rejects with
   * DeepgramHandshakeError for HTTP failures (unexpected-response) or a
   * plain Error for network/timeout — callers classify via
   * classifyHandshakeStatus.
   */
  connect(): Promise<void> {
    if (this.state !== "idle") {
      return Promise.reject(new Error(`DeepgramStream ${this.sessionId} already connected`))
    }
    this.state = "connecting"

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      })
      this.ws = ws
      let settled = false

      const settleHandshake = (): void => {
        settled = true
        clearTimeout(handshakeTimer)
      }

      const handshakeTimer = setTimeout(() => {
        if (settled) return
        settleHandshake()
        this.closedByUs = true
        this.state = "closed"
        try {
          ws.terminate()
        } catch {
          // Socket already gone.
        }
        reject(new DeepgramHandshakeError(null, "Speech provider handshake timed out"))
      }, this.handshakeTimeoutMs)
      handshakeTimer.unref?.()

      ws.on("open", () => {
        if (settled) return
        settleHandshake()
        this.state = "open"
        this.closedByUs = false
        this.lastAudioSentAtMs = this.now()
        this.startKeepAlive()
        resolve()
      })

      // Handshake failure with an HTTP status (401/402/429/5xx …). The ws
      // client does not auto-terminate after this event — we must.
      ws.on("unexpected-response", (_req: unknown, res: IncomingMessage) => {
        res.resume()
        if (settled) return
        settleHandshake()
        const status = res.statusCode ?? null
        this.closedByUs = true
        this.state = "closed"
        try {
          ws.terminate()
        } catch {
          // Socket already gone.
        }
        reject(
          new DeepgramHandshakeError(
            status,
            `Speech provider handshake failed (HTTP ${status ?? "unknown"})`
          )
        )
      })

      ws.on("error", (error: Error) => {
        if (!settled) {
          settleHandshake()
          this.closedByUs = true
          this.state = "closed"
          reject(error)
          return
        }
        // Post-open transport error — an outage (counted).
        if (this.state === "open") {
          this.reportFailure({
            action: "count",
            message: `Speech provider connection error: ${error.message}`,
          })
          this.close()
        }
      })

      ws.on("message", (data: RawData, isBinary: boolean) => {
        // Server → client frames are JSON text; binary from the server is
        // not part of the protocol — dropped without logging.
        if (!isBinary) {
          this.handleTextMessage(data.toString())
        }
      })

      ws.on("close", (code: number, reason: Buffer) => {
        this.handleClose(code, reason)
      })
    })
  }

  /**
   * Forward one audio frame (raw binary). Refuses (and fails closed) when
   * the socket is not open or the outbound buffer has blown past the cap —
   * a stalled reader must not make us queue unbounded audio.
   */
  sendAudio(bytes: Buffer): boolean {
    if (this.state !== "open") return false

    if (this.getBufferedAmount() > this.bufferCapBytes) {
      this.reportFailure({
        action: "count",
        message: "Speech provider stopped accepting audio (backpressure limit).",
      })
      this.close()
      return false
    }

    const ws = this.ws
    if (ws === null) return false

    try {
      ws.send(bytes, { binary: true }, (error: Error | null | undefined) => {
        if (error) {
          this.reportFailure({
            action: "count",
            message: `Could not send audio to the speech provider: ${error.message}`,
          })
          this.close()
        }
      })
    } catch {
      this.reportFailure({
        action: "count",
        message: "Could not send audio to the speech provider.",
      })
      this.close()
      return false
    }

    this.lastAudioSentAtMs = this.now()
    return true
  }

  /**
   * Flush the utterance: send Finalize and wait for the flushed final
   * (from_finalize). Resolves with the final transcript (null when the
   * utterance had no speech — an empty flush is success, not a failure).
   * A timeout with NO transcript at all is an outage (counted); a timeout
   * that still has an earlier final delivers that final instead.
   */
  finalize(): Promise<string | null> {
    if (this.finalizePromise !== null) return this.finalizePromise

    if (this.state !== "open") {
      if (this.finalText !== null && !this.delivered && !this.failureReported) {
        this.deliver(this.finalText, false)
      }
      return Promise.resolve(this.finalText)
    }

    try {
      this.ws?.send(JSON.stringify({ type: "Finalize" }))
    } catch {
      this.reportFailure({
        action: "count",
        message: "Could not finalise the speech stream.",
      })
      return Promise.resolve(null)
    }

    this.finalizePromise = new Promise<string | null>(resolve => {
      this.resolveFinal = resolve
      this.awaitingFinal = true
      this.finalizeTimer = setTimeout(() => {
        this.handleFinalizeTimeout()
      }, this.finalizeTimeoutMs)
      this.finalizeTimer.unref?.()
    })
    return this.finalizePromise
  }

  /**
   * Close path (Day 5 rule 2): CloseStream, then close — on client close,
   * voice_end, session/utterance caps, supersede and shutdown. Idempotent.
   */
  close(): void {
    if (this.state === "closed") return
    const wasOpen = this.state === "open"
    this.closedByUs = true
    this.stopTimers()

    // A deliberate close resolves any in-flight Finalize wait with whatever
    // finals we already have (deliver-once), never with a failure.
    if (this.awaitingFinal && this.resolveFinal !== null) {
      this.settleFinalize(this.finalText)
    }

    const ws = this.ws
    this.state = "closed"
    if (ws === null) return

    const ready = ws.readyState
    if (wasOpen && ready === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }))
      } catch {
        // Socket racing closed — the close event still fires.
      }
    }
    if (ready === WebSocket.OPEN) {
      try {
        ws.close()
      } catch {
        // Already closing.
      }
    } else if (ready === WebSocket.CONNECTING) {
      try {
        ws.terminate()
      } catch {
        // Already gone.
      }
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      if (this.state !== "open") return
      // Audio has been flowing recently — Deepgram already sees life.
      if (this.now() - this.lastAudioSentAtMs < this.keepAliveQuietMs) return
      try {
        // TEXT frame on purpose (docs/audio-keep-alive).
        this.ws?.send(JSON.stringify({ type: "KeepAlive" }))
      } catch {
        // Socket racing closed — the close event reports the real problem.
      }
    }, this.keepAliveMs)
    this.keepAliveTimer.unref?.()
  }

  private stopTimers(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
    if (this.finalizeTimer !== null) {
      clearTimeout(this.finalizeTimer)
      this.finalizeTimer = null
    }
  }

  private handleTextMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // Non-JSON server frame — nothing safe to act on.
    }
    if (typeof parsed !== "object" || parsed === null) return
    const message = parsed as Record<string, unknown>

    switch (message.type) {
      case "Results":
        this.handleResults(message)
        break
      case "Error": {
        // Deepgram: Error frames are non-fatal (fatal failures close the
        // socket instead) — surface them, do not count toward the breaker.
        const variant = typeof message.variant === "string" ? message.variant : "ProviderError"
        const description =
          typeof message.description === "string" ? message.description : "unknown error"
        this.reportFailure({
          action: "ignore",
          message: `Speech provider error: ${variant} — ${description}`,
        })
        this.close()
        break
      }
      case "Metadata":
      case "UtteranceEnd":
      case "SpeechStarted":
      case "ConfigureSuccess":
      case "ConfigureFailure":
        // Informational — none of these carry transcript content.
        break
      default:
        break
    }
  }

  private handleResults(message: Record<string, unknown>): void {
    const channel = message.channel as Record<string, unknown> | undefined
    const alternatives = channel?.alternatives as Array<Record<string, unknown>> | undefined
    const transcript =
      typeof alternatives?.[0]?.transcript === "string" ? alternatives[0].transcript.trim() : ""

    const fromFinalize = message.from_finalize === true
    const isFinal = message.is_final === true || message.speech_final === true

    // Interims are never requested (interim_results=false); if one slips
    // through anyway it is dropped — never delivered, logged or persisted.
    if (!isFinal && !fromFinalize) return

    if (transcript !== "") {
      this.finalText = transcript
    }
    if (fromFinalize && this.awaitingFinal) {
      this.settleFinalize(this.finalText)
    }
  }

  private settleFinalize(text: string | null): void {
    if (this.finalizeTimer !== null) {
      clearTimeout(this.finalizeTimer)
      this.finalizeTimer = null
    }
    this.awaitingFinal = false
    if (text !== null) {
      this.deliver(text, true)
    }
    const resolve = this.resolveFinal
    this.resolveFinal = null
    resolve?.(text)
  }

  private handleFinalizeTimeout(): void {
    this.finalizeTimer = null
    if (!this.awaitingFinal) return

    if (this.finalText !== null) {
      // The flush stalled but earlier finals exist — deliver them (no error).
      this.settleFinalize(this.finalText)
      return
    }

    // No final at all after Finalize — provider stalled (counted).
    this.awaitingFinal = false
    const resolve = this.resolveFinal
    this.resolveFinal = null
    this.reportFailure({
      action: "count",
      message: "No final transcript after Finalize (timeout).",
    })
    resolve?.(null)
  }

  private handleClose(code: number, reason: Buffer): void {
    const wasOpen = this.state === "open"
    const deliberate = this.closedByUs
    this.stopTimers()
    this.state = "closed"

    // An unexpected drop resolves an in-flight Finalize wait with whatever
    // finals exist (partial transcript preservation) before reporting.
    if (!deliberate && this.awaitingFinal && this.resolveFinal !== null) {
      if (this.finalText !== null) {
        this.settleFinalize(this.finalText)
      } else {
        this.awaitingFinal = false
        const resolve = this.resolveFinal
        this.resolveFinal = null
        resolve?.(null)
      }
    }

    if (!wasOpen || deliberate || this.failureReported) return
    const reasonText = reason.length > 0 ? `: ${reason.toString()}` : ""
    this.reportFailure({
      action: "count",
      message: `Speech provider closed the stream unexpectedly (code ${code}${reasonText}).`,
    })
  }

  private deliver(text: string, fromFinalize: boolean): void {
    if (this.delivered || this.failureReported) return
    this.delivered = true
    this.onFinal(text, fromFinalize)
  }

  private reportFailure(failure: DeepgramStreamFailure): void {
    if (this.failureReported) return
    this.failureReported = true
    this.onFailure(failure)
  }
}
