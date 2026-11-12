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
