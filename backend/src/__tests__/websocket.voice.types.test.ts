// backend/src/__tests__/websocket.voice.types.test.ts
//
// Day 1: the three new client voice messages must pass the single JSON
// admission gate (parseClientMessage), the voice server messages must
// serialise, and the voice contract constants must stay pinned — voice.types
// is imported as values here so coverage counts the module (its other exports
// are types and erase at compile time).

import { parseClientMessage, toJson, type ServerMessage } from "../types/websocket.types"
import {
  VOICE_SAMPLE_RATE,
  VOICE_MAX_FRAME_BYTES,
  VOICE_MAX_UTTERANCE_MS,
  VOICE_MAX_SESSION_MS,
  VOICE_MAX_TRANSCRIPT_CHARS,
  TTS_SEQUENCE_PREFIX_BYTES,
} from "../types/voice.types"

describe("voice client messages (parse)", () => {
  it("parses voice_start", () => {
    const parsed = parseClientMessage(JSON.stringify({ type: "voice_start", sessionId: "s1" }))
    expect(parsed).toEqual({ type: "voice_start", sessionId: "s1" })
  })

  it("parses barge_in", () => {
    const parsed = parseClientMessage(JSON.stringify({ type: "barge_in", sessionId: "s1" }))
    expect(parsed).toEqual({ type: "barge_in", sessionId: "s1" })
  })

  it("parses voice_end", () => {
    const parsed = parseClientMessage(JSON.stringify({ type: "voice_end", sessionId: "s1" }))
    expect(parsed).toEqual({ type: "voice_end", sessionId: "s1" })
  })

  it("still rejects unknown or malformed types", () => {
    expect(parseClientMessage(JSON.stringify({ type: "voice_mystery" }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 42 }))).toBeNull()
    expect(parseClientMessage("not json")).toBeNull()
  })
})

describe("voice server messages (serialise)", () => {
  it("round-trips transcript_final with latencyMs", () => {
    const message: ServerMessage = {
      type: "transcript_final",
      sessionId: "s1",
      text: "what is rag",
      latencyMs: 320,
    }
    expect(JSON.parse(toJson(message))).toEqual(message)
  })

  it("keeps voice_error code part of the typed union", () => {
    const message: ServerMessage = {
      type: "voice_error",
      sessionId: "s1",
      code: "STT_FAILED",
      message: "transcription failed",
    }
    expect(JSON.parse(toJson(message))).toEqual(message)
  })
})

describe("voice contract constants (Day 1)", () => {
  it("pins the audio contract and hard caps", () => {
    expect(VOICE_SAMPLE_RATE).toBe(16_000)
    expect(VOICE_MAX_FRAME_BYTES).toBe(4096)
    expect(VOICE_MAX_UTTERANCE_MS).toBe(60_000)
    expect(VOICE_MAX_SESSION_MS).toBe(600_000)
    expect(VOICE_MAX_TRANSCRIPT_CHARS).toBe(500)
    expect(TTS_SEQUENCE_PREFIX_BYTES).toBe(4)
  })
})
