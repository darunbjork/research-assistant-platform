// backend/src/__tests__/voice.providers.test.ts
//
// Day 2: the STT/TTS provider boundary — deterministic mocks (no network,
// no billing), factory mode selection (mock vs not-yet-written real
// clients), and breaker wrapping. Nothing here can reach Deepgram or
// ElevenLabs.

import {
  MockSttService,
  createSttService,
  getSttService,
  sttBreaker,
} from "../services/stt.service"
import {
  MockTtsService,
  createTtsService,
  getTtsService,
  ttsBreaker,
} from "../services/tts.service"
import { CircuitBreaker } from "../utils/circuit-breaker"

describe("MockSttService", () => {
  const service = new MockSttService()

  it("derives a deterministic transcript from audio length", async () => {
    const oneSecond = Buffer.alloc(16_000 * 2) // 1 s of PCM16 @ 16 kHz
    const first = await service.transcribe({ audioPcm16: oneSecond, sessionId: "s1" })
    const second = await service.transcribe({ audioPcm16: oneSecond, sessionId: "s1" })
    expect(first).toEqual(second)
    expect(first.text).toBe("mock transcript (1000ms, session s1)")
    expect(first.latencyMs).toBe(1)
  })

  it("scales the reported duration with the audio length", async () => {
    const halfSecond = Buffer.alloc(8_000 * 2)
    const result = await service.transcribe({ audioPcm16: halfSecond, sessionId: "s2" })
    expect(result.text).toContain("500ms")
    expect(result.text).toContain("session s2")
  })
})

describe("MockTtsService", () => {
  const service = new MockTtsService()

  it("returns silence sized at 10 ms per character", async () => {
    const result = await service.synthesize({ text: "a".repeat(250), sessionId: "s1" })
    // 2500 ms × 24 000 samples/s (TTS_SAMPLE_RATE) × 2 bytes = 120 000 bytes
    expect(result.audioPcm16).toHaveLength(120_000)
    expect(result.audioPcm16.every((byte: number) => byte === 0)).toBe(true)
  })

  it("returns an empty buffer for empty text", async () => {
    const result = await service.synthesize({ text: "", sessionId: "s1" })
    expect(result.audioPcm16).toHaveLength(0)
  })
})

describe("createSttService / createTtsService", () => {
  it("mock mode returns the deterministic stubs", () => {
    expect(createSttService(true)).toBeInstanceOf(MockSttService)
    expect(createTtsService("mock")).toBeInstanceOf(MockTtsService)
  })

  it("real mode keeps batch STT out (streaming since Day 5)", () => {
    expect(() => createSttService(false)).toThrow("deepgram.stream.ts")
  })

  it("wraps the service with the breaker when one is supplied", async () => {
    const breaker = new CircuitBreaker("wrap-test", {
      failureThreshold: 1,
      cooldownMs: 1000,
      now: () => 0,
    })
    const stt = createSttService(true, breaker)
    const ok = await stt.transcribe({ audioPcm16: Buffer.alloc(32_000), sessionId: "s" })
    expect(ok.text).toContain("1000ms") // 32 000 bytes = 16 000 samples = 1 s
    expect(breaker.state).toBe("closed")
    expect(breaker.consecutiveFailures).toBe(0)
  })
})

describe("process-wide services (VOICE_MOCK=true, TTS_PROVIDER=mock in tests)", () => {
  it("getSttService/getTtsService memoise and delegate to the deterministic mocks", async () => {
    expect(getSttService()).toBe(getSttService())
    expect(getTtsService()).toBe(getTtsService())

    // Both are wrapped in the process breaker, so assert by behaviour, not
    // by class instance.
    const stt = await getSttService().transcribe({
      audioPcm16: Buffer.alloc(32_000),
      sessionId: "s",
    })
    expect(stt.text).toBe("mock transcript (1000ms, session s)")

    let bytes = 0
    for await (const chunk of getTtsService().synthesizeStream(
      { text: "hi", sessionId: "s" },
      new AbortController().signal
    )) {
      bytes += chunk.length
    }
    expect(bytes).toBe(960) // 2 chars → 20 ms → 480 samples × 2 bytes
  })

  it("exports named breakers for the two providers", () => {
    expect(sttBreaker.name).toBe("deepgram-stt")
    expect(ttsBreaker.name).toBe("elevenlabs-tts")
    expect(sttBreaker.state).toBe("closed")
    expect(ttsBreaker.state).toBe("closed")
  })
})
