// frontend/src/hooks/useVoiceCapture.test.ts
// Day 4: mic capture must emit 16 kHz PCM16 frames, gate silence out
// (cost control — docs/cost.md §3), and tear the mic down completely on
// stopCapture(). Browser APIs (getUserMedia, AudioContext, AudioWorkletNode)
// are stubbed — nothing touches real hardware.

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  useVoiceCapture,
  computeRms,
  floatToPcm16,
  resampleLinear,
  pushPreRoll,
  VOICE_FRAME_SAMPLES,
  VOICE_SILENCE_THRESHOLD,
  VOICE_PRE_ROLL_SAMPLES,
  VOICE_HANGOVER_MS
} from "./useVoiceCapture"

// ── Browser double ────────────────────────────────────────────────────────
class MockWorkletNode {
  name: string
  port = {
    onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
    postMessage: vi.fn()
  }
  connect = vi.fn()
  disconnect = vi.fn()

  constructor(name: string) {
    this.name = name
  }
}

class MockAudioContext {
  static ignoreRequestedSampleRate = false

  sampleRate: number
  state = "running"
  destination = {}
  audioWorklet = {
    addModule: vi.fn(() => Promise.resolve())
  }
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
const MockWorkletNodes: MockWorkletNode[] = []

function fireAudio(samples: Float32Array): void {
  const node = MockWorkletNodes.at(-1)
  if (node === undefined || node.port.onmessage === null) {
    throw new Error("worklet not wired")
  }
  node.port.onmessage({ data: samples } as unknown as MessageEvent<Float32Array>)
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

  it("pushPreRoll keeps only the newest 250 ms of samples", () => {
    const ring = pushPreRoll(new Float32Array(4000).fill(1), new Float32Array(1000).fill(2))
    expect(ring.length).toBe(VOICE_PRE_ROLL_SAMPLES)
    expect(ring[0]).toBe(1) // oldest surviving sample (index 1000 of batch 1)
    expect(ring[3000]).toBe(2) // newest batch starts here
    expect(ring[3999]).toBe(2)
  })
})

describe("useVoiceCapture", () => {
  beforeEach(() => {
    MockAudioContextInstances.length = 0
    MockWorkletNodes.length = 0
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
    vi.stubGlobal("AudioWorkletNode", class extends MockWorkletNode {
      constructor(_ctx: AudioContext, name: string) {
        super(name)
        MockWorkletNodes.push(this)
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
    // The worklet is a static same-origin module, not a blob: (see the
    // addModule call in useVoiceCapture.ts for the CSP reasoning).
    expect(latestContext().audioWorklet.addModule).toHaveBeenCalledWith(
      "/worklets/pcm-capture.js"
    )
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

  it("stopCapture stops the tracks, closes the context and unhooks the worklet", async () => {
    const { result } = await startCapture()
    const ctx = latestContext()
    const node = MockWorkletNodes.at(-1)
    expect(node).toBeDefined()

    act(() => {
      result.current.stopCapture()
    })

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(ctx.close).toHaveBeenCalledTimes(1)
    expect(node?.port.onmessage).toBeNull()
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

  // ── Pre-roll + hangover (Day 4 follow-up) ───────────────────────────────
  it("flushes the quiet pre-roll on onset so the first syllable is not cut", async () => {
    const { frames } = await startCapture()

    // Two quiet buffers (below threshold) are buffered, never sent.
    act(() => {
      fireAudio(new Float32Array(1024).fill(0.005))
    })
    act(() => {
      fireAudio(new Float32Array(1024).fill(0.005))
    })
    expect(frames).toHaveLength(0)

    // Onset: ring (2048 samples) + current (512) flush as one stream.
    act(() => {
      fireAudio(new Float32Array(512).fill(0.5))
    })

    const totalSamples = frames.reduce((n, frame) => n + frame.length / 2, 0)
    expect(totalSamples).toBe(2048 + 512)
    const first = frames[0]
    if (first === undefined) throw new Error("expected a frame")
    const view = new DataView(first.buffer, first.byteOffset, first.byteLength)
    // The frame opens with the pre-roll's quiet samples (0.005 → 164), i.e.
    // audio the old gate would have thrown away.
    expect(view.getInt16(0, true)).toBe(Math.round(0.005 * 0x7fff))
  })

  it("caps the pre-roll ring at 250 ms of samples", async () => {
    const { frames } = await startCapture()

    // 6 × 1024 = 6144 quiet samples — only the newest 4000 stay buffered.
    for (let i = 0; i < 6; i++) {
      act(() => {
        fireAudio(new Float32Array(1024).fill(0.004))
      })
    }
    expect(frames).toHaveLength(0)

    act(() => {
      fireAudio(new Float32Array(512).fill(0.5))
    })

    const totalSamples = frames.reduce((n, frame) => n + frame.length / 2, 0)
    expect(totalSamples).toBe(VOICE_PRE_ROLL_SAMPLES + 512)
  })

  it("hangover: quiet audio keeps flowing for 500 ms, then the gate closes", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    try {
      const { frames, result } = await startCapture()
      const onsetMs = Date.now()

      act(() => {
        fireAudio(new Float32Array(512).fill(0.5)) // speech onset
      })
      expect(result.current.isSpeaking).toBe(true)
      const afterOnset = frames.length
      expect(afterOnset).toBeGreaterThan(0)

      // 100 ms later: still inside the hangover — the quiet tail is sent.
      vi.setSystemTime(onsetMs + 100)
      act(() => {
        fireAudio(new Float32Array(512))
      })
      expect(frames.length).toBeGreaterThan(afterOnset)
      expect(result.current.isSpeaking).toBe(false)

      // Past the hangover: quiet buffers close the gate and are only ringed.
      vi.setSystemTime(onsetMs + VOICE_HANGOVER_MS + 100)
      act(() => {
        fireAudio(new Float32Array(512))
      })
      const afterClose = frames.length
      vi.setSystemTime(onsetMs + VOICE_HANGOVER_MS + 200)
      act(() => {
        fireAudio(new Float32Array(512))
      })
      expect(frames.length).toBe(afterClose) // nothing more is sent
      expect(result.current.isSpeaking).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
