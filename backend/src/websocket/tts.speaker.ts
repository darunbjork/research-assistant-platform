// backend/src/websocket/tts.speaker.ts
//
// Speaks a completed agent answer over the connection's WebSocket:
//   tts_start → binary frames (8-byte LE turn+seq header + PCM16) → tts_done
//
// One speaker per connection, at most one spoken answer at a time. Any new
// speak(), cancel() (barge-in, new question, voice_start, set_speak false,
// socket close) or shutdown aborts the current one: an aborted turn sends
// neither tts_done nor an error. A TTS failure only ever produces a
// voice_error — the text answer has already been delivered and is never
// changed or retracted.

import { setTimeout as delay } from "node:timers/promises"
import type WebSocket from "ws"
import { env } from "../config/env"
import { redis } from "../utils/redis"
import { logError, logRagEvent } from "../utils/logger"
import { voiceTtsCharsTotal, voiceTtsFirstByteSeconds } from "../utils/metrics"
import { RateLimitError } from "../middleware/error.middleware"
import { CircuitOpenError } from "../utils/circuit-breaker"
import { getTtsService, TtsError, type TtsService } from "../services/tts.service"
import { toSpeakableText } from "../services/speakable-text"
import { TTS_SAMPLE_RATE, encodeTtsFrame, type VoiceErrorCode } from "../types/voice.types"
import type { ServerMessage } from "../types/websocket.types"

/** Pause sending while more than this much is queued on the socket. */
export const TTS_BACKPRESSURE_BYTES = 1024 * 1024
const BACKPRESSURE_POLL_MS = 20
/** The daily counter outlives its UTC day so late-night turns still count. */
const DAILY_CHARS_TTL_SECONDS = 48 * 60 * 60

type DailyCharsOutcome = "ok" | "over" | "error"

/** Redis key for one user's spoken characters on one UTC day. */
export function dailyCharsKey(userId: string, now: Date = new Date()): string {
  return `tts:chars:${userId}:${now.toISOString().slice(0, 10)}`
}

/**
 * Add `chars` to the user's daily counter (INCRBY + 48 h TTL) and check it
 * against TTS_DAILY_CHARS_PER_USER. Any Redis problem is "error" — the
 * caller fails closed and skips speaking.
 */
async function reserveDailyChars(userId: string, chars: number): Promise<DailyCharsOutcome> {
  const key = dailyCharsKey(userId)
  try {
    const results = await redis
      .multi()
      .incrby(key, chars)
      .expire(key, DAILY_CHARS_TTL_SECONDS, "NX")
      .exec()
    const total = Number(results?.[0]?.[1])
    if (!Number.isFinite(total)) return "error"
    return total > env.TTS_DAILY_CHARS_PER_USER ? "over" : "ok"
  } catch {
    return "error"
  }
}

/** Provider failure → voice_error code + user-facing message. */
function describeFailure(error: unknown): { code: VoiceErrorCode; message: string } {
  if (error instanceof CircuitOpenError) {
    return { code: "TTS_UNAVAILABLE", message: "Spoken answers are unavailable right now." }
  }
  if (error instanceof TtsError) {
    if (error.code === "TTS_QUOTA") return { code: "TTS_QUOTA", message: error.message }
    if (error.code === "TTS_UNAVAILABLE") return { code: "TTS_UNAVAILABLE", message: error.message }
    return { code: "TTS_FAILED", message: error.message }
  }
  if (error instanceof RateLimitError) {
    return { code: "TTS_UNAVAILABLE", message: error.message }
  }
  return { code: "TTS_FAILED", message: "Could not speak the answer." }
}

export interface TtsSpeakerDeps {
  ws: Pick<WebSocket, "send" | "readyState" | "bufferedAmount">
  send: (message: ServerMessage) => void
  sendVoiceError: (code: VoiceErrorCode, message: string, sessionId: string) => void
  /** Process-wide abort registry, drained on shutdown. */
  registry: Set<AbortController>
  /** Injected for tests; defaults to the process-wide TTS service. */
  tts?: () => TtsService
}

export class TtsSpeaker {
  private turn = 0
  private controller: AbortController | null = null

  constructor(private readonly deps: TtsSpeakerDeps) {}

  /** Stop the current spoken answer, if any (no tts_done, no error). */
  cancel(): void {
    this.controller?.abort()
  }

  /** True while an answer is being spoken. */
  get isSpeaking(): boolean {
    return this.controller !== null && !this.controller.signal.aborted
  }

  /** Speak `answer` for agent session `sessionId`. Never throws. */
  async speak(userId: string, sessionId: string, answer: string): Promise<void> {
    this.cancel()
    const text = toSpeakableText(answer, env.TTS_MAX_CHARS)
    if (text === "") return

    const controller = new AbortController()
    const { signal } = controller
    this.controller = controller
    this.deps.registry.add(controller)

    try {
      const budget = await reserveDailyChars(userId, text.length)
      if (signal.aborted) return
      if (budget === "over") {
        this.deps.sendVoiceError(
          "TTS_DAILY_LIMIT",
          "Daily spoken-answer limit reached — answers stay as text until tomorrow.",
          sessionId
        )
        return
      }
      if (budget === "error") {
        logRagEvent("agent_step", "TTS skipped: daily character counter unavailable", {
          service: "TtsSpeaker",
          sessionId,
        })
        this.deps.sendVoiceError(
          "TTS_UNAVAILABLE",
          "Spoken answers are unavailable right now.",
          sessionId
        )
        return
      }

      const turn = ++this.turn
      this.deps.send({
        type: "tts_start",
        sessionId,
        turn,
        sampleRate: TTS_SAMPLE_RATE,
        chars: text.length,
      })

      const tts = (this.deps.tts ?? getTtsService)()
      const startedAt = Date.now()
      let seq = 0
      for await (const chunk of tts.synthesizeStream({ text, sessionId }, signal)) {
        if (seq === 0) {
          // First audio proves the provider accepted (and bills) the text.
          voiceTtsFirstByteSeconds.observe((Date.now() - startedAt) / 1000)
          voiceTtsCharsTotal.inc(text.length)
        }
        if (!(await this.waitForDrain(signal))) return
        this.deps.ws.send(encodeTtsFrame(turn, seq, chunk), { binary: true })
        seq += 1
      }
      if (signal.aborted) return

      this.deps.send({ type: "tts_done", sessionId, turn })
      logRagEvent("agent_step", "Answer spoken", {
        service: "TtsSpeaker",
        sessionId,
        turn,
        chars: text.length,
        frames: seq,
        durationMs: Date.now() - startedAt,
      })
    } catch (error: unknown) {
      if (signal.aborted) return
      const { code, message } = describeFailure(error)
      logError("Speaking the answer failed", error, { service: "TtsSpeaker", sessionId, code })
      this.deps.sendVoiceError(code, message, sessionId)
    } finally {
      this.deps.registry.delete(controller)
      if (this.controller === controller) this.controller = null
    }
  }

  /**
   * Wait while the socket's send buffer is over the backpressure limit.
   * False when the turn was aborted or the socket is no longer open.
   */
  private async waitForDrain(signal: AbortSignal): Promise<boolean> {
    while (!signal.aborted && this.deps.ws.readyState === 1) {
      if (this.deps.ws.bufferedAmount <= TTS_BACKPRESSURE_BYTES) return true
      await delay(BACKPRESSURE_POLL_MS)
    }
    return false
  }
}
