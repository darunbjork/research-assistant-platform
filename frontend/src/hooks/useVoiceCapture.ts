// frontend/src/hooks/useVoiceCapture.ts
// Day 4: microphone capture for the voice layer.
//
// Captures mic audio, converts it to 16 kHz PCM16 (little-endian) frames no
// larger than the server's 4096-byte frame cap, and applies *silence gating*:
// while the gate is closed only the last VOICE_PRE_ROLL_MS of audio is
// buffered, never sent — an always-open mic streams ~6x the STT cost of a
// gated one (docs/cost.md §3). On speech onset the pre-roll is flushed first
// so the first syllable is not cut, and audio keeps flowing for
// VOICE_HANGOVER_MS after the voice drops so word tails are not clipped.
// Audio must stop entirely after voice_end — the caller does that by
// invoking stopCapture().
//
// The server still runs MOCK STT (VOICE_MOCK=true); nothing here reaches a
// provider until Day 5+ is explicitly enabled.

import { useCallback, useEffect, useRef, useState } from "react"

export const VOICE_SAMPLE_RATE = 16000
/** 2048 samples x 2 bytes = 4096 bytes — exactly the server frame cap. */
export const VOICE_FRAME_SAMPLES = 2048
/** RMS below this = silence; such frames are gated (cost gate). */
export const VOICE_SILENCE_THRESHOLD = 0.01
/** Audio buffered while the gate is closed and flushed on speech onset. */
export const VOICE_PRE_ROLL_MS = 250
/** Audio still sent after the last above-threshold buffer (word tails). */
export const VOICE_HANGOVER_MS = 500
/** 250 ms of 16 kHz samples — the pre-roll ring's cap. */
export const VOICE_PRE_ROLL_SAMPLES = Math.round((VOICE_PRE_ROLL_MS / 1000) * VOICE_SAMPLE_RATE)

/**
 * Append to the pre-roll ring, keeping only the newest VOICE_PRE_ROLL_SAMPLES
 * (a 250 ms window at 16 kHz). Exported for the unit tests.
 */
export function pushPreRoll(
  previous: Float32Array,
  next: Float32Array
): Float32Array<ArrayBuffer> {
  const merged = new Float32Array(previous.length + next.length)
  merged.set(previous)
  merged.set(next, previous.length)
  return merged.length > VOICE_PRE_ROLL_SAMPLES
    ? merged.slice(merged.length - VOICE_PRE_ROLL_SAMPLES)
    : merged
}

/** RMS energy of a float32 PCM buffer. */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0
    sum += s * s
  }
  return Math.sqrt(sum / samples.length)
}

/** float32 [-1, 1] → PCM16 little-endian bytes (the server wire format). */
export function floatToPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, Math.round(s * 0x7fff), true)
  }
  return new Uint8Array(buffer)
}

/**
 * Linear resample between sample rates. Browsers may ignore
 * `new AudioContext({ sampleRate: 16000 })` (Safari does), so every buffer
 * is normalised to VOICE_SAMPLE_RATE before it is framed.
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const ratio = fromRate / toRate
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const a = input[i0] ?? 0
    const b = input[i0 + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

export type VoiceFrameHandler = (frame: Uint8Array<ArrayBuffer>) => void

export interface UseVoiceCaptureReturn {
  /** Microphone stream is live and frames are flowing (subject to gating). */
  isCapturing: boolean
  /** The most recent buffer was above the silence threshold (UI feedback). */
  isSpeaking: boolean
  error: string | null
  startCapture: (onFrame: VoiceFrameHandler) => Promise<void>
  stopCapture: () => void
}

export function useVoiceCapture(): UseVoiceCaptureReturn {
  const [isCapturing, setIsCapturing] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const speakingRef = useRef(false)

  const stopCapture = useCallback((): void => {
    if (workletRef.current !== null) {
      workletRef.current.port.onmessage = null
      workletRef.current.disconnect()
      workletRef.current = null
    }
    const ctx = ctxRef.current
    ctxRef.current = null
    if (ctx !== null && ctx.state !== "closed") {
      void ctx.close().catch(() => undefined)
    }
    if (streamRef.current !== null) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
    speakingRef.current = false
    setIsSpeaking(false)
    setIsCapturing(false)
  }, [])

  const startCapture = useCallback(
    async (onFrame: VoiceFrameHandler): Promise<void> => {
      // Already capturing — a second start is a no-op (not an error).
      if (streamRef.current !== null) return

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream

        const AudioContextCtor = window.AudioContext
        if (AudioContextCtor === undefined) {
          throw new Error("Web Audio is not supported in this browser")
        }
        const ctx = new AudioContextCtor({ sampleRate: VOICE_SAMPLE_RATE })
        ctxRef.current = ctx
        if (ctx.state === "suspended") await ctx.resume()

        const source = ctx.createMediaStreamSource(stream)

        // AudioWorklet, not the deprecated ScriptProcessorNode: capture is
        // batched on the audio rendering thread, so main-thread jank cannot
        // glitch the mic. The processor is a static same-origin module
        // (public/worklets/pcm-capture.js) — Chrome gates AudioWorklet loads
        // under script-src, so a blob: URL would need script-src blob:;
        // 'self' is already allowed by the Caddy CSP.
        await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/pcm-capture.js`)
        const worklet = new AudioWorkletNode(ctx, "pcm-capture")
        workletRef.current = worklet

        // Gate state lives in the startCapture closure: a fresh startCapture
        // always begins with an empty ring and a closed gate.
        let gateOpen = false
        let hangoverUntilMs = 0
        let preRoll = new Float32Array(0)

        const emit = (samples: Float32Array): void => {
          for (let offset = 0; offset < samples.length; offset += VOICE_FRAME_SAMPLES) {
            const end = Math.min(offset + VOICE_FRAME_SAMPLES, samples.length)
            onFrame(floatToPcm16(samples.subarray(offset, end)))
          }
        }

        worklet.port.onmessage = (event: MessageEvent<Float32Array>): void => {
          const input = event.data
          const samples = resampleLinear(input, ctx.sampleRate, VOICE_SAMPLE_RATE)
          const loud = computeRms(input) >= VOICE_SILENCE_THRESHOLD
          const nowMs = Date.now()

          if (!gateOpen) {
            if (!loud) {
              // Gate closed + quiet: buffer (never send) so onset can flush
              // the lead-in — this is what keeps the first syllable intact.
              preRoll = pushPreRoll(preRoll, samples)
              if (speakingRef.current) {
                speakingRef.current = false
                setIsSpeaking(false)
              }
              return
            }
            // Speech onset: flush the ring (NOT this buffer — it is added
            // below) + this buffer as one stream, open the gate for the
            // hangover window. The server's 2-second pacing burst absorbs
            // this ≤250 ms flush (agent.ws.handler.ts).
            const flush = new Float32Array(preRoll.length + samples.length)
            flush.set(preRoll)
            flush.set(samples, preRoll.length)
            preRoll = new Float32Array(0)
            emit(flush)
            gateOpen = true
            hangoverUntilMs = nowMs + VOICE_HANGOVER_MS
            if (!speakingRef.current) {
              speakingRef.current = true
              setIsSpeaking(true)
            }
            return
          }

          // Gate open: stream everything so words are not clipped.
          if (loud) {
            emit(samples)
            hangoverUntilMs = nowMs + VOICE_HANGOVER_MS
            if (!speakingRef.current) {
              speakingRef.current = true
              setIsSpeaking(true)
            }
            return
          }
          if (nowMs < hangoverUntilMs) {
            // Quiet, but still inside the hangover — send the tail.
            emit(samples)
            if (speakingRef.current) {
              speakingRef.current = false
              setIsSpeaking(false)
            }
            return
          }
          // Hangover expired: close the gate; this buffer seeds the next
          // pre-roll instead of being sent.
          gateOpen = false
          if (speakingRef.current) {
            speakingRef.current = false
            setIsSpeaking(false)
          }
          preRoll = pushPreRoll(preRoll, samples)
        }

        source.connect(worklet)
        // The node must reach the destination for the graph to be pulled;
        // its output buffer is never written to, so nothing is audible.
        worklet.connect(ctx.destination)
        setError(null)
        setIsCapturing(true)
      } catch (err: unknown) {
        stopCapture()
        setError(err instanceof Error && err.message ? err.message : "Microphone access failed")
      }
    },
    [stopCapture]
  )

  // The mic must never outlive the component.
  useEffect(() => {
    return () => stopCapture()
  }, [stopCapture])

  return { isCapturing, isSpeaking, error, startCapture, stopCapture }
}
