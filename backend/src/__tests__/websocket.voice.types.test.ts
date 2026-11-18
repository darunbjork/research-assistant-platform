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
  TTS_SAMPLE_RATE,
  TTS_FRAME_HEADER_BYTES,
  encodeTtsFrame,
  decodeTtsFrame,
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

  it("parses set_speak with a boolean enabled flag", () => {
    expect(parseClientMessage(JSON.stringify({ type: "set_speak", enabled: true }))).toEqual({
      type: "set_speak",
      enabled: true,
    })
    expect(parseClientMessage(JSON.stringify({ type: "set_speak", enabled: false }))).toEqual({
      type: "set_speak",
      enabled: false,
    })
  })

  it("rejects set_speak without a boolean enabled flag", () => {
    expect(parseClientMessage(JSON.stringify({ type: "set_speak" }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: "set_speak", enabled: "yes" }))).toBeNull()
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
      complete: true,
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

  it("round-trips tts_start and tts_done with the turn number", () => {
    const start: ServerMessage = {
      type: "tts_start",
      sessionId: "s1",
      turn: 3,
      sampleRate: TTS_SAMPLE_RATE,
      chars: 120,
    }
    const done: ServerMessage = { type: "tts_done", sessionId: "s1", turn: 3 }
    expect(JSON.parse(toJson(start))).toEqual(start)
    expect(JSON.parse(toJson(done))).toEqual(done)
  })
})

describe("TTS binary frames", () => {
  it("prefixes audio with an 8-byte little-endian (turn, seq) header", () => {
    const audio = Buffer.from([1, 2, 3, 4])
    const frame = encodeTtsFrame(7, 258, audio)
    expect(frame).toHaveLength(TTS_FRAME_HEADER_BYTES + 4)
    // turn 7 LE, seq 258 = 0x0102 LE
    expect([...frame.subarray(0, 8)]).toEqual([7, 0, 0, 0, 2, 1, 0, 0])
    expect(decodeTtsFrame(frame)).toEqual({ turn: 7, seq: 258, audio })
  })

  it("handles the full uint32 range", () => {
    const frame = encodeTtsFrame(0xffffffff, 0, Buffer.alloc(0))
    expect(decodeTtsFrame(frame).turn).toBe(0xffffffff)
  })
})

describe("voice contract constants (Day 1)", () => {
  it("pins the audio contract and hard caps", () => {
    expect(VOICE_SAMPLE_RATE).toBe(16_000)
    expect(VOICE_MAX_FRAME_BYTES).toBe(4096)
    expect(VOICE_MAX_UTTERANCE_MS).toBe(60_000)
    expect(VOICE_MAX_SESSION_MS).toBe(600_000)
    expect(VOICE_MAX_TRANSCRIPT_CHARS).toBe(500)
    expect(TTS_SAMPLE_RATE).toBe(24_000)
    expect(TTS_FRAME_HEADER_BYTES).toBe(8)
  })
})
