// backend/src/services/stt.service.ts
//
// Speech-to-text provider boundary (voice curriculum Day 2). Callers (WS
// voice handling, Day 3) depend only on the SttService interface; the
// deterministic mock keeps VOICE_MOCK=true (the default) completely offline
// and unbilled, and the real Deepgram client (Day 5) slots in behind the
// same interface without touching callers.

import { VOICE_SAMPLE_RATE } from "../types/voice.types"
import { CircuitBreaker } from "../utils/circuit-breaker"
import { env } from "../config/env"

export interface SttTranscribeRequest {
  /** PCM16 little-endian mono audio at VOICE_SAMPLE_RATE. */
  audioPcm16: Buffer
  sessionId: string
}

export interface SttTranscribeResult {
  text: string
  /** Provider-side processing time; mock returns a fixed 1 ms (deterministic). */
  latencyMs: number
}

export interface SttService {
  transcribe(request: SttTranscribeRequest): Promise<SttTranscribeResult>
}

/** Deterministic mock: no network, no billing, same input → same output. */
export class MockSttService implements SttService {
  async transcribe(request: SttTranscribeRequest): Promise<SttTranscribeResult> {
    const durationMs = Math.round((request.audioPcm16.length / 2 / VOICE_SAMPLE_RATE) * 1000)
    return {
      text: `mock transcript (${durationMs}ms, session ${request.sessionId})`,
      latencyMs: 1,
    }
  }
}

/** Breaker guarding the Deepgram endpoint (trips → PROVIDER_UNAVAILABLE). */
export const sttBreaker = new CircuitBreaker("deepgram-stt")

/**
 * Build the STT service for a mode. Real mode throws until the Deepgram
 * client lands on Day 5 — env.ts already forces the key to exist when
 * VOICE_MOCK=false, but the client itself is not written yet.
 */
export function createSttService(voiceMock: boolean, breaker?: CircuitBreaker): SttService {
  if (!voiceMock) {
    throw new Error("Real Deepgram STT is not implemented yet (voice Day 5)")
  }
  const inner = new MockSttService()
  if (!breaker) return inner
  return {
    transcribe: request => breaker.exec(() => inner.transcribe(request)),
  }
}

let defaultStt: SttService | null = null

/** Process-wide STT service chosen from env.VOICE_MOCK (lazy, memoised). */
export function getSttService(): SttService {
  defaultStt ??= createSttService(env.VOICE_MOCK, sttBreaker)
  return defaultStt
}
