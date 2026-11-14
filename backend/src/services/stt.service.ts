// backend/src/services/stt.service.ts
//
// Speech-to-text provider boundary (voice curriculum Day 2). The
// deterministic mock keeps VOICE_MOCK=true (the default) completely offline
// and unbilled. Day 5 landed the real client as a STREAMING session in
// deepgram.stream.ts (Deepgram WebSocket, one stream per utterance) — this
// batch interface stays as the offline/mock transcription boundary; the
// streaming client is what the WS handler opens when VOICE_MOCK=false.

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
 * Build the STT service for a mode. Batch real-mode transcription is not
 * used — VOICE_MOCK=false streams through deepgram.stream.ts (opened by the
 * WS handler); this factory keeps the mock path for offline callers.
 */
export function createSttService(voiceMock: boolean, breaker?: CircuitBreaker): SttService {
  if (!voiceMock) {
    throw new Error("Batch STT is unused in real mode — voice streams via deepgram.stream.ts")
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
