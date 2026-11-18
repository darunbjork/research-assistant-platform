// backend/src/types/voice.types.ts
//
// Voice-layer foundation types (voice curriculum Day 1): audio contract,
// hard caps, session lifecycle, error codes and the transcript row shape.
// The wire protocol lives in websocket.types.ts (additive messages only);
// the Deepgram / ElevenLabs service code arrives on Days 3/5/8 and imports
// from here so every cap has exactly one home.

/** Audio the browser streams up: PCM16 little-endian, 16 kHz mono. */
export const VOICE_SAMPLE_RATE = 16_000

/**
 * Audio the server streams down for spoken answers: PCM16 little-endian,
 * 24 kHz mono (ElevenLabs `pcm_24000`). Deliberately separate from the
 * 16 kHz STT rate — the two directions never share a sample rate.
 */
export const TTS_SAMPLE_RATE = 24_000

/** One audio_chunk WS frame (client→server) may carry at most this many bytes. */
export const VOICE_MAX_FRAME_BYTES = 4096

/** One utterance (voice_start → voice_end) may last at most 60 seconds. */
export const VOICE_MAX_UTTERANCE_MS = 60_000

/** One voice session may last at most 10 minutes. */
export const VOICE_MAX_SESSION_MS = 10 * 60_000

/** Final transcripts longer than this are rejected (they feed the LLM). */
export const VOICE_MAX_TRANSCRIPT_CHARS = 500

/**
 * Every TTS binary frame (server→client) starts with an 8-byte header:
 *   bytes 0-3  uint32 LE  turn — which spoken answer this audio belongs to
 *   bytes 4-7  uint32 LE  seq  — 0-based frame index within that turn
 * followed by PCM16 LE mono audio at TTS_SAMPLE_RATE.
 *
 * `turn` lets the browser drop frames still in flight from an answer that
 * was interrupted (barge-in, new question). Little-endian matches the PCM
 * byte order and `DataView.getUint32(offset, true)` in the browser.
 */
export const TTS_FRAME_HEADER_BYTES = 8

/** Build one TTS binary frame: 8-byte LE header (turn, seq) + PCM16 audio. */
export function encodeTtsFrame(turn: number, seq: number, audio: Buffer): Buffer {
  const header = Buffer.alloc(TTS_FRAME_HEADER_BYTES)
  header.writeUInt32LE(turn >>> 0, 0)
  header.writeUInt32LE(seq >>> 0, 4)
  return Buffer.concat([header, audio])
}

/** Read the header of a TTS binary frame (inverse of encodeTtsFrame). */
export function decodeTtsFrame(frame: Buffer): { turn: number; seq: number; audio: Buffer } {
  return {
    turn: frame.readUInt32LE(0),
    seq: frame.readUInt32LE(4),
    audio: frame.subarray(TTS_FRAME_HEADER_BYTES),
  }
}

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
  | "TTS_UNAVAILABLE" // speech provider down / breaker open (text answer unaffected)
  | "TTS_QUOTA" // ElevenLabs credit cap spent
  | "TTS_DAILY_LIMIT" // per-user daily spoken-character budget used up
  | "PROVIDER_UNAVAILABLE" // provider circuit breaker open (Day 2)
  | "VOICE_BUDGET_REACHED" // provider quota/402 — cap spent, not an outage (Day 5)
  | "NO_VOICE_SESSION" // audio or voice_end arrived without an active session
  | "TRANSCRIPT_INCOMPLETE" // final transcript incomplete (timeout/drop/closed/not_open)
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
