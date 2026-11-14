// backend/src/__tests__/voice.transcript.service.test.ts
//
// Day 3b: VoiceTranscript persistence —
//   - saves final transcripts (text only, never audio)
//   - rejects empty / over-limit text without touching the DB
//   - every read is tenant-filtered by userId
//   - DB failures fail soft (null / [])

import type { VoiceTranscriptRecord } from "../types/voice.types"

const mockCreate = jest.fn()
const mockFindMany = jest.fn()
const mockDeleteMany = jest.fn()

jest.mock("../utils/prisma", () => ({
  prisma: {
    voiceTranscript: {
      create: (...args: unknown[]): unknown => mockCreate(...args),
      findMany: (...args: unknown[]): unknown => mockFindMany(...args),
      deleteMany: (...args: unknown[]): unknown => mockDeleteMany(...args),
    },
  },
}))

const {
  saveVoiceTranscript,
  listVoiceTranscripts,
  purgeExpiredVoiceTranscripts,
  startTranscriptPurgeTimer,
} =
  require("../services/voice.transcript.service") as typeof import("../services/voice.transcript.service")

const row = {
  id: "vt-1",
  userId: "user-1",
  sessionId: "sess-1",
  text: "hello world",
  latencyMs: 420,
  createdAt: new Date("2026-11-12T10:00:00Z"),
}

describe("voice transcript service (Day 3b)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("saveVoiceTranscript", () => {
    it("persists a valid transcript and returns the record", async () => {
      mockCreate.mockResolvedValue(row)

      const result = await saveVoiceTranscript({
        userId: "user-1",
        sessionId: "sess-1",
        text: "  hello world  ",
        latencyMs: 420,
      })

      expect(mockCreate).toHaveBeenCalledWith({
        data: { userId: "user-1", sessionId: "sess-1", text: "hello world", latencyMs: 420 },
      })
      expect(result).toEqual<VoiceTranscriptRecord>({
        id: "vt-1",
        userId: "user-1",
        sessionId: "sess-1",
        text: "hello world",
        latencyMs: 420,
        createdAt: row.createdAt,
      })
    })

    it("refuses empty text without touching the DB", async () => {
      const result = await saveVoiceTranscript({
        userId: "user-1",
        sessionId: "sess-1",
        text: "   ",
        latencyMs: 10,
      })

      expect(result).toBeNull()
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it("refuses text beyond VOICE_MAX_TRANSCRIPT_CHARS (500) without touching the DB", async () => {
      const result = await saveVoiceTranscript({
        userId: "user-1",
        sessionId: "sess-1",
        text: "x".repeat(501),
        latencyMs: 10,
      })

      expect(result).toBeNull()
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it("fails soft on a DB error", async () => {
      mockCreate.mockRejectedValueOnce(new Error("db down"))

      const result = await saveVoiceTranscript({
        userId: "user-1",
        sessionId: "sess-1",
        text: "hello",
        latencyMs: 10,
      })

      expect(result).toBeNull()
    })
  })

  describe("listVoiceTranscripts", () => {
    it("always filters by the requesting userId (tenant isolation)", async () => {
      mockFindMany.mockResolvedValueOnce([row])

      const results = await listVoiceTranscripts("user-1")

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        orderBy: { createdAt: "desc" },
        take: 50,
      })
      expect(results).toHaveLength(1)
      expect(results[0]?.userId).toBe("user-1")
    })

    it("clamps the limit into 1..100", async () => {
      mockFindMany.mockResolvedValueOnce([])

      await listVoiceTranscripts("user-1", 9999)

      expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }))
    })

    it("fails soft on a DB error", async () => {
      mockFindMany.mockRejectedValueOnce(new Error("db down"))

      await expect(listVoiceTranscripts("user-1")).resolves.toEqual([])
    })
  })

  // ── Retention (Day 3b): spoken content is personal data ────────────────
  describe("retention purge (30 days)", () => {
    it("save triggers a per-user sweep past the cutoff", async () => {
      mockCreate.mockResolvedValue(row)
      mockDeleteMany.mockResolvedValue({ count: 2 })

      await saveVoiceTranscript({
        userId: "user-1",
        sessionId: "sess-1",
        text: "hello",
        latencyMs: 10,
      })
      await new Promise(resolve => setImmediate(resolve)) // let the void purge settle

      expect(mockDeleteMany).toHaveBeenCalledTimes(1)
      const arg = (mockDeleteMany.mock.calls[0] as unknown[] | undefined)?.[0] as {
        where: { userId?: string; createdAt: { lt: Date } }
      }
      expect(arg.where.userId).toBe("user-1")
      expect(arg.where.createdAt.lt).toBeInstanceOf(Date)
    })

    it("global purge (startup) deletes every tenant's expired rows", async () => {
      mockDeleteMany.mockResolvedValue({ count: 3 })

      await expect(purgeExpiredVoiceTranscripts()).resolves.toBe(3)

      const arg = (mockDeleteMany.mock.calls[0] as unknown[] | undefined)?.[0] as {
        where: { userId?: string; createdAt: { lt: Date } }
      }
      expect(arg.where.userId).toBeUndefined()
      const expectedCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      expect(Math.abs(arg.where.createdAt.lt.getTime() - expectedCutoff)).toBeLessThan(5_000)
    })

    it("user-scoped purge only touches that user's rows", async () => {
      mockDeleteMany.mockResolvedValue({ count: 1 })

      await expect(purgeExpiredVoiceTranscripts("user-1")).resolves.toBe(1)

      const arg = (mockDeleteMany.mock.calls[0] as unknown[] | undefined)?.[0] as {
        where: { userId?: string }
      }
      expect(arg.where.userId).toBe("user-1")
    })

    it("fails soft on a DB error", async () => {
      mockDeleteMany.mockRejectedValueOnce(new Error("db down"))

      await expect(purgeExpiredVoiceTranscripts()).resolves.toBe(0)
    })
  })

  // ── Daily in-process sweep (Day 4 follow-up) ────────────────────────────
  describe("startTranscriptPurgeTimer", () => {
    it("sweeps on the interval; stop() clears the timer (and unref'd handle)", () => {
      jest.useFakeTimers()
      try {
        mockDeleteMany.mockResolvedValue({ count: 0 })

        const stop = startTranscriptPurgeTimer(1000)
        expect(mockDeleteMany).not.toHaveBeenCalled()

        jest.advanceTimersByTime(1000)
        expect(mockDeleteMany).toHaveBeenCalledTimes(1)

        stop()
        jest.advanceTimersByTime(10_000)
        expect(mockDeleteMany).toHaveBeenCalledTimes(1) // cleared — no more sweeps
      } finally {
        jest.useRealTimers()
      }
    })
  })
})
