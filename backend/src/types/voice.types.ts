// backend/src/types/voice.types.ts
//
// Voice-layer foundation types (voice curriculum Day 1): audio contract,
// hard caps, session lifecycle, error codes and the transcript row shape.
// The wire protocol lives in websocket.types.ts (additive messages only);
// the Deepgram / ElevenLabs service code arrives on Days 3/5/8 and imports
// from here so every cap has exactly one home.

/** Audio the browser streams up: PCM16 little-endian, 16 kHz mono. */
export const VOICE_SAMPLE_RATE = 16_000

/** One audio_chunk WS frame (client→server) may carry at most this many bytes. */
export const VOICE_MAX_FRAME_BYTES = 4096

/** One utterance (voice_start → voice_end) may last at most 60 seconds. */
export const VOICE_MAX_UTTERANCE_MS = 60_000

/** One voice session may last at most 10 minutes. */
export const VOICE_MAX_SESSION_MS = 10 * 60_000

/** Final transcripts longer than this are rejected (they feed the LLM). */
export const VOICE_MAX_TRANSCRIPT_CHARS = 500

/**
 * Every tts_chunk binary frame (server→client) starts with a 4-byte
 * big-endian uint32 sequence number, then the audio payload (format decided
 * on Day 8). Documented here so Day 8 and the frontend share one rule.
 */
export const TTS_SEQUENCE_PREFIX_BYTES = 4

/** Lifecycle of one voice session on the server (drives voice_error timing). */
export type VoiceSessionPhase =
  | "idle" // connected, no voice session yet
  | "listening" // audio accepted, waiting for voice_end / final transcript
  | "transcribing" // final transcript in flight (mock or Deepgram)
  | "thinking" // existing agent run consuming the final text
  | "summarising" // spoken-summary LLM call (Day 6)
  | "speaking" // TTS chunks being relayed (Day 8)
  | "error" // terminal until the client sends voice_start again

/** Machine-readable codes sent in VoiceErrorMessage.code. */
export type VoiceErrorCode =
  | "VOICE_RATE_LIMITED" // voice limiter refused the action (fail closed)
  | "VOICE_CAPACITY_REACHED" // global daily budget exhausted
  | "SESSION_LIMIT" // session count / duration cap hit
  | "UTTERANCE_TOO_LONG" // >60s of audio before voice_end
  | "FRAME_TOO_LARGE" // audio_chunk bigger than VOICE_MAX_FRAME_BYTES
  | "TRANSCRIPT_TOO_LONG" // final transcript beyond VOICE_MAX_TRANSCRIPT_CHARS
  | "NOT_AUTHENTICATED" // voice_start without valid auth
  | "TOKEN_EXPIRED" // access token expired and refresh failed
  | "STT_FAILED" // Deepgram error or bad payload
  | "TTS_FAILED" // ElevenLabs error or bad payload
  | "PROVIDER_UNAVAILABLE" // provider circuit breaker open (Day 2)
  | "VOICE_BUDGET_REACHED" // provider quota/402 — cap spent, not an outage (Day 5)
  | "NO_VOICE_SESSION" // audio or voice_end arrived without an active session
  | "VOICE_INTERNAL" // unexpected server fault (logged, generic on the wire)

/**
 * Row shape of a persisted transcript (Prisma model VoiceTranscript, Day 3
 * migration). Raw audio is NEVER persisted — text only.
 */
export interface VoiceTranscriptRecord {
  id: string
  userId: string
  sessionId: string
  text: string
  latencyMs: number
  createdAt: Date
}
