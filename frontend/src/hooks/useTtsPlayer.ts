// frontend/src/hooks/useTtsPlayer.ts
//
// Plays spoken answers streamed by the server (VOICE_TTS_PLAN Phase 5).
//
// Wire format of each binary frame:
//   bytes 0-3  uint32 LE  turn   bytes 4-7  uint32 LE  seq   then PCM16 LE mono
// Frames are scheduled back to back on one AudioContext clock, so playback
// is gapless however the network spaces them. Frames whose `turn` is not
// the current one (an interrupted answer still in flight) are dropped.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const TTS_FRAME_HEADER_BYTES = 8;
/** Small lead so the first chunk is never scheduled in the past. */
const START_LEAD_SECONDS = 0.05;

export interface TtsFrameHeader {
  turn: number;
  seq: number;
}

/** Read the 8-byte little-endian (turn, seq) header of a TTS frame. */
export function readTtsHeader(data: ArrayBuffer): TtsFrameHeader | null {
  if (data.byteLength < TTS_FRAME_HEADER_BYTES) return null;
  const view = new DataView(data);
  return { turn: view.getUint32(0, true), seq: view.getUint32(4, true) };
}

/** PCM16 LE → Float32 in [-1, 1). */
export function pcm16ToFloat32(data: ArrayBuffer, byteOffset: number): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor((data.byteLength - byteOffset) / 2);
  const view = new DataView(data, byteOffset, sampleCount * 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
}

/** The parts of the player the WebSocket hook feeds. */
export interface TtsSink {
  start: (turn: number, sampleRate: number) => void;
  frame: (data: ArrayBuffer) => void;
  /** No more frames for `turn` (or the current turn when omitted). */
  done: (turn?: number) => void;
}

export interface TtsPlayer extends TtsSink {
  /** True from tts_start until the last scheduled audio has played (or stop()). */
  isSpeaking: boolean;
  /**
   * Create/resume the AudioContext. Call from a user gesture (a click or
   * key press) — browsers keep audio suspended until the user interacts.
   */
  prime: () => void;
  /** Stop every scheduled chunk now and drop the rest of the turn. */
  stop: () => void;
}

export function useTtsPlayer(): TtsPlayer {
  const contextRef = useRef<AudioContext | null>(null);
  const turnRef = useRef<number | null>(null);
  const finishedTurnRef = useRef<number | null>(null);
  const sampleRateRef = useRef(24_000);
  const nextStartRef = useRef(0);
  const sourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const [isSpeaking, setIsSpeaking] = useState(false);

  const ensureContext = useCallback((): AudioContext | null => {
    if (contextRef.current === null) {
      try {
        contextRef.current = new AudioContext();
      } catch {
        return null; // no Web Audio (old browser, test env): stay silent
      }
    }
    const context = contextRef.current;
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    return context;
  }, []);

  const settleIfFinished = useCallback((): void => {
    if (
      turnRef.current !== null &&
      finishedTurnRef.current === turnRef.current &&
      sourcesRef.current.size === 0
    ) {
      turnRef.current = null;
      setIsSpeaking(false);
    }
  }, []);

  const stopSources = useCallback((): void => {
    // Clearing the set first makes the stopped sources' onended a no-op.
    const stopping = [...sourcesRef.current];
    sourcesRef.current.clear();
    for (const source of stopping) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
  }, []);

  const stop = useCallback((): void => {
    stopSources();
    turnRef.current = null;
    finishedTurnRef.current = null;
    setIsSpeaking(false);
  }, [stopSources]);

  const start = useCallback(
    (turn: number, sampleRate: number): void => {
      stopSources();
      const context = ensureContext();
      turnRef.current = turn;
      finishedTurnRef.current = null;
      sampleRateRef.current = sampleRate;
      nextStartRef.current = (context?.currentTime ?? 0) + START_LEAD_SECONDS;
      setIsSpeaking(true);
    },
    [ensureContext, stopSources],
  );

  const frame = useCallback(
    (data: ArrayBuffer): void => {
      const header = readTtsHeader(data);
      if (header === null || header.turn !== turnRef.current) return; // stale or unknown
      const context = contextRef.current;
      if (context === null) return;

      const samples = pcm16ToFloat32(data, TTS_FRAME_HEADER_BYTES);
      if (samples.length === 0) return;
      const buffer = context.createBuffer(1, samples.length, sampleRateRef.current);
      buffer.copyToChannel(samples, 0);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      // Back to back on the audio clock; if the network fell behind, start now.
      const startAt = Math.max(nextStartRef.current, context.currentTime);
      source.start(startAt);
      nextStartRef.current = startAt + buffer.duration;

      sourcesRef.current.add(source);
      source.onended = () => {
        if (!sourcesRef.current.delete(source)) return; // stopped by stop()
        settleIfFinished();
      };
    },
    [settleIfFinished],
  );

  const done = useCallback(
    (turn?: number): void => {
      if (turnRef.current === null) return;
      if (turn !== undefined && turn !== turnRef.current) return;
      finishedTurnRef.current = turnRef.current;
      settleIfFinished();
    },
    [settleIfFinished],
  );

  useEffect(() => {
    return () => {
      stopSources();
      void contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
    };
  }, [stopSources]);

  return useMemo(
    () => ({ isSpeaking, prime: () => void ensureContext(), start, frame, done, stop }),
    [isSpeaking, ensureContext, start, frame, done, stop],
  );
}
