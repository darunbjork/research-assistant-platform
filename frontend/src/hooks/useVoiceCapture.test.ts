// frontend/src/hooks/useVoiceCapture.test.ts
// Day 4: mic capture must emit 16 kHz PCM16 frames, gate silence out
// (cost control — docs/cost.md §3), and tear the mic down completely on
// stopCapture(). Browser APIs (getUserMedia, AudioContext) are stubbed —
// nothing touches real hardware.

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  useVoiceCapture,
  computeRms,
  floatToPcm16,
  resampleLinear,
  VOICE_FRAME_SAMPLES,
  VOICE_SILENCE_THRESHOLD
} from "./useVoiceCapture"

// ── Browser double ────────────────────────────────────────────────────────
class MockProcessor {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null
  bufferSize = 0
  connect = vi.fn()
  disconnect = vi.fn()
}

class MockAudioContext {
  static ignoreRequestedSampleRate = false

  sampleRate: number
  state = "running"
  destination = {}
  processors: MockProcessor[] = []
  close = vi.fn(() => {
    this.state = "closed"
    return Promise.resolve()
  })
  resume = vi.fn(() => Promise.resolve())

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = MockAudioContext.ignoreRequestedSampleRate
      ? 48000
      : (options?.sampleRate ?? 48000)
  }

  createScriptProcessor(bufferSize: number): MockProcessor {
    const processor = new MockProcessor()
    processor.bufferSize = bufferSize
    this.processors.push(processor)
    return processor
  }

  createMediaStreamSource(): { connect: ReturnType<typeof vi.fn> } {
    return { connect: vi.fn() }
  }
}

const getUserMedia = vi.fn()
const track = { stop: vi.fn() }
const stream = { getTracks: () => [track] }

function latestContext(): MockAudioContext {
  const ctx = MockAudioContextInstances.at(-1)
  if (ctx === undefined) throw new Error("AudioContext was not created")
  return ctx
}

// Alias so latestContext can read the static list without importing cycles.
const MockAudioContextInstances: MockAudioContext[] = []

function fireAudio(samples: Float32Array): void {
  const ctx = latestContext()
  const processor = ctx.processors[0]
  if (processor?.onaudioprocess === null || processor === undefined) {
    throw new Error("processor not wired")
  }
  processor.onaudioprocess({
    inputBuffer: { getChannelData: () => samples }
  } as unknown as AudioProcessingEvent)
}

async function startCapture(): Promise<{
  frames: Uint8Array[]
  result: { current: ReturnType<typeof useVoiceCapture> }
}> {
  const rendered = renderHook(() => useVoiceCapture())
  const frames: Uint8Array[] = []
  await act(async () => {
    await rendered.result.current.startCapture(frame => frames.push(frame))
  })
  return { frames, result: rendered.result }
}

describe("voice capture helpers", () => {
  it("computeRms returns the root-mean-square energy", () => {
    expect(computeRms(new Float32Array([0.6, 0.8]))).toBeCloseTo(Math.sqrt(0.5), 5)
    expect(computeRms(new Float32Array(0))).toBe(0)
  })

  it("floatToPcm16 writes little-endian int16 samples", () => {
    const bytes = floatToPcm16(new Float32Array([1, -1, 0]))
    expect(bytes.length).toBe(6)
    const view = new DataView(bytes.buffer)
    expect(view.getInt16(0, true)).toBe(32767)
    expect(view.getInt16(2, true)).toBe(-32767)
    expect(view.getInt16(4, true)).toBe(0)
  })

  it("resampleLinear is an identity pass at equal rates", () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(resampleLinear(input, 16000, 16000)).toBe(input)
  })

  it("resampleLinear downsamples by the rate ratio", () => {
    const input = new Float32Array([0, 1, 0, 1, 0, 1])
    const out = resampleLinear(input, 48000, 16000)
    expect(out.length).toBe(2)
  })
})

describe("useVoiceCapture", () => {
  beforeEach(() => {
    MockAudioContextInstances.length = 0
    MockAudioContext.ignoreRequestedSampleRate = false
    track.stop.mockClear()
    getUserMedia.mockReset()
    getUserMedia.mockResolvedValue(stream)
    vi.stubGlobal("AudioContext", class extends MockAudioContext {
      constructor(options?: { sampleRate?: number }) {
        super(options)
        MockAudioContextInstances.push(this)
      }
    })
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("opens an audio-only stream at the requested 16 kHz", async () => {
    const { result } = await startCapture()

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(latestContext().sampleRate).toBe(16000)
    expect(result.current.isCapturing).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it("emits a PCM16 frame for audible audio", async () => {
    const { frames } = await startCapture()

    act(() => {
      fireAudio(new Float32Array(1024).fill(0.5))
    })

    expect(frames).toHaveLength(1)
    const frame = frames[0]
    if (frame === undefined) throw new Error("expected one frame")
    expect(frame).toBeInstanceOf(Uint8Array)
    expect(frame.length).toBe(2048) // 1024 samples × 2 bytes
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    expect(view.getInt16(0, true)).toBe(16384) // round(0.5 × 32767)
  })

  it("silence gating: quiet frames are never sent", async () => {
    const { frames, result } = await startCapture()

    act(() => {
      fireAudio(new Float32Array(1024)) // pure silence, RMS = 0
    })

    expect(frames).toHaveLength(0)
    expect(result.current.isSpeaking).toBe(false)
  })

  it("drops frames below the RMS threshold and keeps frames above it", async () => {
    const { frames } = await startCapture()

    act(() => {
      fireAudio(new Float32Array(512).fill(VOICE_SILENCE_THRESHOLD / 2))
    })
    expect(frames).toHaveLength(0)

    act(() => {
      fireAudio(new Float32Array(512).fill(VOICE_SILENCE_THRESHOLD * 2))
    })
    expect(frames).toHaveLength(1)
  })

  it("tracks isSpeaking transitions across loud and quiet buffers", async () => {
    const { result } = await startCapture()

    act(() => {
      fireAudio(new Float32Array(256).fill(0.3))
    })
    expect(result.current.isSpeaking).toBe(true)

    act(() => {
      fireAudio(new Float32Array(256))
    })
    expect(result.current.isSpeaking).toBe(false)
  })

  it("splits long audible buffers into frames of at most 4096 bytes", async () => {
    const { frames } = await startCapture()

    act(() => {
      fireAudio(new Float32Array(4096).fill(0.4)) // 2 × 2048 samples
    })

    expect(frames).toHaveLength(2)
    expect(frames[0]?.length).toBe(VOICE_FRAME_SAMPLES * 2)
    expect(frames[1]?.length).toBe(VOICE_FRAME_SAMPLES * 2)
  })

  it("resamples when the browser ignores the 16 kHz request", async () => {
    MockAudioContext.ignoreRequestedSampleRate = true
    const { frames } = await startCapture()
    expect(latestContext().sampleRate).toBe(48000)

    act(() => {
      fireAudio(new Float32Array(4800).fill(0.4)) // → 1600 samples at 16 kHz
    })

    expect(frames).toHaveLength(1)
    expect(frames[0]?.length).toBe(3200)
  })

  it("stopCapture stops the tracks, closes the context and unhooks the processor", async () => {
    const { result } = await startCapture()
    const ctx = latestContext()
    const processor = ctx.processors[0]
    expect(processor).toBeDefined()

    act(() => {
      result.current.stopCapture()
    })

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(ctx.close).toHaveBeenCalledTimes(1)
    expect(processor?.onaudioprocess).toBeNull()
    expect(result.current.isCapturing).toBe(false)
    expect(result.current.isSpeaking).toBe(false)
  })

  it("startCapture twice opens only one stream", async () => {
    const { result } = await startCapture()
    await act(async () => {
      await result.current.startCapture(() => undefined)
    })

    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it("a denied microphone surfaces an error and captures nothing", async () => {
    getUserMedia.mockRejectedValue(new Error("Permission denied"))
    const rendered = renderHook(() => useVoiceCapture())
    await act(async () => {
      await rendered.result.current.startCapture(() => undefined)
    })

    expect(rendered.result.current.error).toBe("Permission denied")
    expect(rendered.result.current.isCapturing).toBe(false)
    expect(MockAudioContextInstances).toHaveLength(0)
  })
})
