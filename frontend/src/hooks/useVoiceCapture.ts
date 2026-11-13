// frontend/src/hooks/useVoiceCapture.ts
// Day 4: microphone capture for the voice layer.
//
// Captures mic audio, converts it to 16 kHz PCM16 (little-endian) frames no
// larger than the server's 4096-byte frame cap, and applies *silence gating*:
// frames whose RMS energy is below the threshold are never sent. An
// always-open mic streams ~6x the STT cost of a gated one (docs/cost.md §3),
// and audio must stop entirely after voice_end — the caller does that by
// invoking stopCapture().
//
// The server still runs MOCK STT (VOICE_MOCK=true); nothing here reaches a
// provider until Day 5+ is explicitly enabled.

import { useCallback, useEffect, useRef, useState } from "react"

export const VOICE_SAMPLE_RATE = 16000
/** 2048 samples x 2 bytes = 4096 bytes — exactly the server frame cap. */
export const VOICE_FRAME_SAMPLES = 2048
/** RMS below this = silence; such frames are dropped (cost gate). */
export const VOICE_SILENCE_THRESHOLD = 0.01

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
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const speakingRef = useRef(false)

  const stopCapture = useCallback((): void => {
    if (processorRef.current !== null) {
      processorRef.current.onaudioprocess = null
      processorRef.current.disconnect()
      processorRef.current = null
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
        // ScriptProcessorNode is deprecated in favour of AudioWorklet, but
        // it is the only option that needs no separately-served module file;
        // the output buffer is never written to, so nothing is audible.
        const processor = ctx.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor

        processor.onaudioprocess = (event: AudioProcessingEvent): void => {
          const input = event.inputBuffer.getChannelData(0)

          // Silence gating — never send quiet frames (docs/cost.md §3).
          if (computeRms(input) < VOICE_SILENCE_THRESHOLD) {
            if (speakingRef.current) {
              speakingRef.current = false
              setIsSpeaking(false)
            }
            return
          }

          const samples = resampleLinear(input, ctx.sampleRate, VOICE_SAMPLE_RATE)
          for (let offset = 0; offset < samples.length; offset += VOICE_FRAME_SAMPLES) {
            const end = Math.min(offset + VOICE_FRAME_SAMPLES, samples.length)
            onFrame(floatToPcm16(samples.subarray(offset, end)))
          }
          if (!speakingRef.current) {
            speakingRef.current = true
            setIsSpeaking(true)
          }
        }

        source.connect(processor)
        // The processor must reach the destination for Chrome to pump
        // audio callbacks; its output buffer stays silent.
        processor.connect(ctx.destination)
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
