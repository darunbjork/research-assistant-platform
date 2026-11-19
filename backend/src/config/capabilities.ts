// backend/src/config/capabilities.ts
//
// What this server can actually do, derived from existing config (no new
// env vars). The frontend reads it from GET /api/v1/config to disable the
// controls the server can't serve, and the WebSocket handler enforces the
// same answer (defence in depth).
//
// Voice counts as available only with a REAL provider configured:
//   stt: VOICE_MOCK=false      (Deepgram; env.ts then requires its key)
//   tts: TTS_PROVIDER=elevenlabs (env.ts then requires key + voice id)
// The mock providers are for development and tests, not users, so they
// report false. Only these two booleans leave the server: never whether a
// key is set, never a model or provider name.
import type { Env } from "./env"

export interface VoiceCapability {
  /** Voice input (speech-to-text) is served. */
  stt: boolean
  /** Spoken answers (text-to-speech) are served. */
  tts: boolean
}

export interface ServerCapabilities {
  voice: VoiceCapability
}

export function voiceCapability(config: Pick<Env, "VOICE_MOCK" | "TTS_PROVIDER">): VoiceCapability {
  return {
    stt: config.VOICE_MOCK === false,
    tts: config.TTS_PROVIDER === "elevenlabs",
  }
}

export function serverCapabilities(
  config: Pick<Env, "VOICE_MOCK" | "TTS_PROVIDER">
): ServerCapabilities {
  return { voice: voiceCapability(config) }
}
