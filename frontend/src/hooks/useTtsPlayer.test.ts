// frontend/src/hooks/useTtsPlayer.test.ts
// The spoken-answer player: gapless scheduling on the AudioContext clock,
// stale-turn frames dropped, stop() clearing the queue, and the isSpeaking
// lifecycle. AudioContext is a recording double — no real audio.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pcm16ToFloat32,
  readTtsHeader,
  TTS_FRAME_HEADER_BYTES,
  useTtsPlayer,
} from "./useTtsPlayer";

class MockSource {
  buffer: MockBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect = vi.fn();
  start(when: number): void {
    this.startedAt = when;
  }
  stop(): void {
    this.stopped = true;
  }
  /** Simulate the browser finishing playback. */
  end(): void {
    this.onended?.();
  }
}

class MockBuffer {
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  channel: Float32Array | null = null;
  constructor(length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
  }
  copyToChannel(data: Float32Array): void {
    this.channel = data;
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  currentTime = 10;
  state = "running";
  destination = {};
  sources: MockSource[] = [];
  closed = false;
  constructor() {
    MockAudioContext.instances.push(this);
  }
  createBuffer(_channels: number, length: number, sampleRate: number): MockBuffer {
    return new MockBuffer(length, sampleRate);
  }
  createBufferSource(): MockSource {
    const source = new MockSource();
    this.sources.push(source);
    return source;
  }
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** One TTS frame: 8-byte LE (turn, seq) header + `samples` PCM16 samples. */
function frame(turn: number, seq: number, samples: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(TTS_FRAME_HEADER_BYTES + samples.length * 2);
  const view = new DataView(buffer);
  view.setUint32(0, turn, true);
  view.setUint32(4, seq, true);
  samples.forEach((sample, index) => view.setInt16(8 + index * 2, sample, true));
  return buffer;
}

const SAMPLE_RATE = 24_000;
/** 2400 samples = exactly 0.1 s at 24 kHz. */
const tenthOfASecond = (): number[] => new Array<number>(2400).fill(0);

function context(): MockAudioContext {
  const latest = MockAudioContext.instances.at(-1);
  if (latest === undefined) throw new Error("no AudioContext created");
  return latest;
}

describe("useTtsPlayer", () => {
  beforeEach(() => {
    MockAudioContext.instances = [];
    vi.stubGlobal("AudioContext", MockAudioContext);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not create an AudioContext until it is primed or a turn starts", () => {
    const { result } = renderHook(() => useTtsPlayer());
    expect(MockAudioContext.instances).toHaveLength(0);
    act(() => result.current.prime());
    expect(MockAudioContext.instances).toHaveLength(1);
  });

  it("schedules frames back to back with no gaps", () => {
    const { result } = renderHook(() => useTtsPlayer());
    act(() => result.current.prime());
    act(() => result.current.start(1, SAMPLE_RATE));
    act(() => {
      result.current.frame(frame(1, 0, tenthOfASecond()));
      result.current.frame(frame(1, 1, tenthOfASecond()));
      result.current.frame(frame(1, 2, tenthOfASecond()));
    });

    const starts = context().sources.map((source) => source.startedAt ?? NaN);
    expect(starts[0]).toBeCloseTo(10.05); // currentTime + 50 ms lead
    expect(starts[1]).toBeCloseTo(10.15);
    expect(starts[2]).toBeCloseTo(10.25);
    expect(context().sources.every((source) => source.connect.mock.calls.length === 1)).toBe(true);
  });

  it("starts immediately when the network fell behind the audio clock", () => {
    const { result } = renderHook(() => useTtsPlayer());
    act(() => result.current.start(1, SAMPLE_RATE));
    act(() => result.current.frame(frame(1, 0, tenthOfASecond())));
    context().currentTime = 20; // long stall
    act(() => result.current.frame(frame(1, 1, tenthOfASecond())));
    expect(context().sources[1]?.startedAt).toBe(20);
  });

  it("drops frames from a turn that is not the current one", () => {
    const { result } = renderHook(() => useTtsPlayer());
    act(() => result.current.start(2, SAMPLE_RATE));
    act(() => {
      result.current.frame(frame(1, 7, tenthOfASecond())); // stale answer
      result.current.frame(frame(2, 0, tenthOfASecond()));
    });
    expect(context().sources).toHaveLength(1);
  });

  it("stop() stops every scheduled chunk and drops the rest of the turn", () => {
    const { result } = renderHook(() => useTtsPlayer());
    act(() => result.current.start(1, SAMPLE_RATE));
    act(() => {
      result.current.frame(frame(1, 0, tenthOfASecond()));
      result.current.frame(frame(1, 1, tenthOfASecond()));
    });
    expect(result.current.isSpeaking).toBe(true);

    act(() => result.current.stop());
    expect(context().sources.every((source) => source.stopped)).toBe(true);
    expect(result.current.isSpeaking).toBe(false);

    act(() => result.current.frame(frame(1, 2, tenthOfASecond())));
    expect(context().sources).toHaveLength(2);
  });

  it("isSpeaking stays true until tts_done AND the last chunk has played", () => {
    const { result } = renderHook(() => useTtsPlayer());
    act(() => result.current.start(1, SAMPLE_RATE));
    act(() => {
      result.current.frame(frame(1, 0, tenthOfASecond()));
      result.current.frame(frame(1, 1, tenthOfASecond()));
    });
    act(() => context().sources[0]?.end());
    expect(result.current.isSpeaking).toBe(true); // more frames may come

    act(() => result.current.done(1));
    expect(result.current.isSpeaking).toBe(true); // second chunk still playing

    act(() => context().sources[1]?.end());
    expect(result.current.isSpeaking).toBe(false);
  });

  it("ignores tts_done for another turn", () => {
    const { result } = renderHook(() => useTtsPlayer());
    act(() => result.current.start(3, SAMPLE_RATE));
    act(() => result.current.done(2));
    expect(result.current.isSpeaking).toBe(true);
    act(() => result.current.done());
    expect(result.current.isSpeaking).toBe(false);
  });

  it("a new turn stops the previous turn's audio", () => {
    const { result } = renderHook(() => useTtsPlayer());
    act(() => result.current.start(1, SAMPLE_RATE));
    act(() => result.current.frame(frame(1, 0, tenthOfASecond())));
    act(() => result.current.start(2, SAMPLE_RATE));
    expect(context().sources[0]?.stopped).toBe(true);
    expect(result.current.isSpeaking).toBe(true);
  });

  it("closes the AudioContext on unmount", () => {
    const { result, unmount } = renderHook(() => useTtsPlayer());
    act(() => result.current.prime());
    unmount();
    expect(context().closed).toBe(true);
  });

  it("stays silent without Web Audio support", () => {
    vi.stubGlobal("AudioContext", undefined);
    const { result } = renderHook(() => useTtsPlayer());
    act(() => result.current.start(1, SAMPLE_RATE));
    expect(() => act(() => result.current.frame(frame(1, 0, [1, 2])))).not.toThrow();
  });
});

describe("TTS frame decoding", () => {
  it("reads the little-endian (turn, seq) header", () => {
    expect(readTtsHeader(frame(258, 7, []))).toEqual({ turn: 258, seq: 7 });
    expect(readTtsHeader(new ArrayBuffer(4))).toBeNull();
  });

  it("converts PCM16 to float samples in [-1, 1)", () => {
    const samples = pcm16ToFloat32(frame(1, 0, [0, 16384, -32768, 32767]), 8);
    expect(Array.from(samples)).toEqual([0, 0.5, -1, 32767 / 32768]);
  });
});
