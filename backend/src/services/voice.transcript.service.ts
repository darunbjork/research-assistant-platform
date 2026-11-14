// backend/src/services/voice.transcript.service.ts
//
// Day 3b: persistence for voice transcripts (VoiceTranscript table).
//   - TEXT ONLY — raw audio is never persisted anywhere.
//   - Tenant-filtered: every read/write is scoped to an explicit userId.
//   - Transcript text is never logged above debug (this module logs only
//     metadata: ids and character counts).
//   - Fails soft: a persistence error returns null / [] and never crashes
//     the voice stream (Day 5 keeps speaking regardless of storage).

import { prisma } from "../utils/prisma"
import { logRagEvent, logError } from "../utils/logger"
import { VOICE_MAX_TRANSCRIPT_CHARS } from "../types/voice.types"
import type { VoiceTranscriptRecord } from "../types/voice.types"

export interface SaveVoiceTranscriptInput {
  userId: string
  sessionId: string
  text: string
  latencyMs: number
}

/** Spoken content is personal data — transcripts are kept at most 30 days. */
export const VOICE_TRANSCRIPT_RETENTION_DAYS = 30

function toRecord(row: {
  id: string
  userId: string
  sessionId: string
  text: string
  latencyMs: number
  createdAt: Date
}): VoiceTranscriptRecord {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    text: row.text,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  }
}

/**
 * Persist one final transcript. Returns null (and does not write) when the
 * text is empty or beyond VOICE_MAX_TRANSCRIPT_CHARS, and null on any DB
 * error so callers can treat storage as best-effort.
 */
export async function saveVoiceTranscript(
  input: SaveVoiceTranscriptInput
): Promise<VoiceTranscriptRecord | null> {
  const text = input.text.trim()
  if (text.length === 0 || text.length > VOICE_MAX_TRANSCRIPT_CHARS) {
    return null
  }

  try {
    const row = await prisma.voiceTranscript.create({
      data: {
        userId: input.userId,
        sessionId: input.sessionId,
        text,
        latencyMs: input.latencyMs,
      },
    })
    // Metadata only — the transcript text itself is never logged here.
    logRagEvent("agent_step", "Voice transcript persisted", {
      service: "VoiceTranscriptService",
      userId: input.userId,
      sessionId: input.sessionId,
      transcriptChars: text.length,
    })
    // Opportunistic retention sweep (best-effort, never blocks the save).
    void purgeExpiredVoiceTranscripts(input.userId)
    return toRecord(row)
  } catch (error: unknown) {
    logError("Voice transcript save failed", error, {
      service: "VoiceTranscriptService",
      userId: input.userId,
    })
    return null
  }
}

/**
 * List a user's transcripts, newest first. The userId filter is mandatory —
 * there is no code path that reads another tenant's rows.
 */
export async function listVoiceTranscripts(
  userId: string,
  limit = 50
): Promise<VoiceTranscriptRecord[]> {
  const take = Math.min(Math.max(limit, 1), 100)
  try {
    const rows = await prisma.voiceTranscript.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
    })
    return rows.map(toRecord)
  } catch (error: unknown) {
    logError("Voice transcript list failed", error, {
      service: "VoiceTranscriptService",
      userId,
    })
    return []
  }
}

/**
 * Delete transcripts older than the retention window (default 30 days).
 * Called on every save (per-user sweep, uses the (userId, createdAt) index)
 * and on service startup (global sweep) — there is no cron on the single
 * VPS (ADR 0002). User deletion is covered separately by the FK cascade.
 * Fails soft: returns 0 on any error.
 */
export async function purgeExpiredVoiceTranscripts(
  userId?: string,
  retentionDays: number = VOICE_TRANSCRIPT_RETENTION_DAYS
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  try {
    const result = await prisma.voiceTranscript.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        ...(userId !== undefined ? { userId } : {}),
      },
    })
    return result.count
  } catch (error: unknown) {
    logError("Voice transcript purge failed", error, {
      service: "VoiceTranscriptService",
      userId,
    })
    return 0
  }
}

/** Daily cadence for the in-process retention sweep. */
export const VOICE_TRANSCRIPT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Daily in-process retention sweep. Startup + per-save sweeps alone would
 * strand the transcripts of users who stop using voice until the next
 * deploy; this timer closes that gap without a cron (ADR 0002: single VPS).
 * The timer is unref'd — it never keeps the process alive — and the returned
 * stop function is invoked by the graceful-shutdown sequence.
 */
export function startTranscriptPurgeTimer(
  intervalMs: number = VOICE_TRANSCRIPT_PURGE_INTERVAL_MS
): () => void {
  const timer = setInterval(() => {
    void purgeExpiredVoiceTranscripts()
  }, intervalMs)
  timer.unref()
  return (): void => {
    clearInterval(timer)
  }
}
