// backend/src/services/tts.service.ts
//
// Text-to-speech provider boundary. Mirrors stt.service.ts: one interface,
// a deterministic mock (silence sized from the text, no network) and the
// real ElevenLabs client. The provider is chosen by TTS_PROVIDER, which is
// independent of VOICE_MOCK (that flag controls speech-to-text only).

import { TTS_SAMPLE_RATE } from "../types/voice.types"
import { CircuitBreaker } from "../utils/circuit-breaker"
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
  synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>
}

/** Deterministic mock: ~10 ms of silence per character, no network. */
export class MockTtsService implements TtsService {
  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const durationMs = request.text.length * 10
    const samples = Math.round((durationMs / 1000) * TTS_SAMPLE_RATE)
    return { audioPcm16: Buffer.alloc(samples * 2) }
  }
}

/** Breaker guarding the ElevenLabs endpoint (trips → PROVIDER_UNAVAILABLE). */
export const ttsBreaker = new CircuitBreaker("elevenlabs-tts")

export type TtsProvider = "mock" | "elevenlabs"

/** Build the TTS service for a provider (env.TTS_PROVIDER). */
export function createTtsService(provider: TtsProvider, breaker?: CircuitBreaker): TtsService {
  if (provider === "elevenlabs") {
    throw new Error("ElevenLabs TTS client is not implemented yet")
  }
  const inner = new MockTtsService()
  if (!breaker) return inner
  return {
    synthesize: request => breaker.exec(() => inner.synthesize(request)),
  }
}

let defaultTts: TtsService | null = null

/** Process-wide TTS service chosen from env.TTS_PROVIDER (lazy, memoised). */
export function getTtsService(): TtsService {
  defaultTts ??= createTtsService(env.TTS_PROVIDER, ttsBreaker)
  return defaultTts
}
