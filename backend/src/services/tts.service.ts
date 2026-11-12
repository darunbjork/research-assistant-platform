// backend/src/services/tts.service.ts
//
// Text-to-speech provider boundary (voice curriculum Day 2). Mirrors
// stt.service.ts: interface + deterministic mock now, real ElevenLabs client
// on Day 8. The mock emits silence sized from the text so downstream
// sequencing (Day 8) can be developed and tested offline.

import { VOICE_SAMPLE_RATE } from "../types/voice.types"
import { CircuitBreaker } from "../utils/circuit-breaker"
import { env } from "../config/env"

export interface TtsSynthesizeRequest {
  text: string
  sessionId: string
}

export interface TtsSynthesizeResult {
  /** PCM16 little-endian mono audio at VOICE_SAMPLE_RATE (format re-checked Day 8). */
  audioPcm16: Buffer
}

export interface TtsService {
  synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>
}

/** Deterministic mock: ~10 ms of silence per character, no network. */
export class MockTtsService implements TtsService {
  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const durationMs = request.text.length * 10
    const samples = Math.round((durationMs / 1000) * VOICE_SAMPLE_RATE)
    return { audioPcm16: Buffer.alloc(samples * 2) }
  }
}

/** Breaker guarding the ElevenLabs endpoint (trips → PROVIDER_UNAVAILABLE). */
export const ttsBreaker = new CircuitBreaker("elevenlabs-tts")

/**
 * Build the TTS service for a mode. Real mode throws until the ElevenLabs
 * client lands on Day 8 — env.ts already forces the key to exist when
 * VOICE_MOCK=false, but the client itself is not written yet.
 */
export function createTtsService(voiceMock: boolean, breaker?: CircuitBreaker): TtsService {
  if (!voiceMock) {
    throw new Error("Real ElevenLabs TTS is not implemented yet (voice Day 8)")
  }
  const inner = new MockTtsService()
  if (!breaker) return inner
  return {
    synthesize: request => breaker.exec(() => inner.synthesize(request)),
  }
}

let defaultTts: TtsService | null = null

/** Process-wide TTS service chosen from env.VOICE_MOCK (lazy, memoised). */
export function getTtsService(): TtsService {
  defaultTts ??= createTtsService(env.VOICE_MOCK, ttsBreaker)
  return defaultTts
}
