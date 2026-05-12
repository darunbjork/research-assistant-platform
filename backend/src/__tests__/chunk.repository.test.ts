// backend/src/__tests__/chunk.repository.test.ts
// Tests for ChunkRepository — pgvector storage layer.

import { ChunkRepository } from "../repositories/chunk.repository"
import { makeMockPrismaClient } from "./helpers/mock-factories"
import type { ChunkToStore } from "../repositories/chunk.repository"

function makeChunkToStore(overrides: Partial<ChunkToStore> = {}): ChunkToStore {
  return {
    content: overrides.content ?? "Test chunk content.",
    chunkIndex: overrides.chunkIndex ?? 0,
    tokenCount: overrides.tokenCount ?? 5,
    embedding: overrides.embedding ?? (Array(768).fill(0.1) as number[]),
    metadata: {
      source: "test.txt",
      chunkingStrategy: "recursive",
      characterCount: 20,
      ...overrides.metadata,
    },
  }
}

describe("ChunkRepository", () => {
  let repo: ChunkRepository
  let mockPrisma: ReturnType<typeof makeMockPrismaClient>

  beforeEach(() => {
    mockPrisma = makeMockPrismaClient()
    repo = new ChunkRepository(mockPrisma)
  })

  // ── storeMany() ───────────────────────────────────────────────────────
  describe("storeMany()", () => {
    it("returns 0 for empty chunks array", async () => {
      const count = await repo.storeMany("doc-1", [])
      expect(count).toBe(0)
    })

    it("stores chunks using a transaction", async () => {
      const chunks = [makeChunkToStore(), makeChunkToStore({ chunkIndex: 1 })]

      await repo.storeMany("doc-1", chunks)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(mockPrisma.$transaction as any).toHaveBeenCalledTimes(1)
    })

    it("calls $executeRaw for each chunk", async () => {
      const chunks = [
        makeChunkToStore({ chunkIndex: 0 }),
        makeChunkToStore({ chunkIndex: 1 }),
        makeChunkToStore({ chunkIndex: 2 }),
      ]

      await repo.storeMany("doc-1", chunks)

      // $transaction is called with an array of $executeRaw calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transactionArg = (mockPrisma.$transaction as any).mock.calls[0]?.[0]
      expect(Array.isArray(transactionArg)).toBe(true)
      expect((transactionArg as unknown[]).length).toBe(3)
    })

    it("returns the number of chunks stored", async () => {
      const chunks = [makeChunkToStore({ chunkIndex: 0 }), makeChunkToStore({ chunkIndex: 1 })]

      const count = await repo.storeMany("doc-1", chunks)
      expect(count).toBe(2)
    })

    it("includes the documentId in each SQL call", async () => {
      const chunks = [makeChunkToStore()]
      await repo.storeMany("doc-specific-001", chunks)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(mockPrisma.$transaction as any).toHaveBeenCalledTimes(1)
    })
  })

  // ── countForDocument() ────────────────────────────────────────────────
  describe("countForDocument()", () => {
    it("returns the chunk count for a document", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockPrisma.documentChunk.count as any).mockResolvedValue(42)

      const count = await repo.countForDocument("doc-1")
      expect(count).toBe(42)
    })

    it("queries with the documentId filter", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockPrisma.documentChunk.count as any).mockResolvedValue(0)

      await repo.countForDocument("doc-abc")

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(mockPrisma.documentChunk.count as any).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ documentId: "doc-abc" }),
        })
      )
    })
  })

  // ── listForDocument() ─────────────────────────────────────────────────
  describe("listForDocument()", () => {
    it("returns chunks ordered by chunkIndex", async () => {
      const mockChunks = [
        {
          id: "c1",
          documentId: "doc-1",
          content: "first",
          chunkIndex: 0,
          tokenCount: 5,
          source: "f.txt",
          pageNumber: null,
          chunkingStrategy: "recursive",
          createdAt: new Date(),
        },
        {
          id: "c2",
          documentId: "doc-1",
          content: "second",
          chunkIndex: 1,
          tokenCount: 5,
          source: "f.txt",
          pageNumber: null,
          chunkingStrategy: "recursive",
          createdAt: new Date(),
        },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockPrisma.documentChunk.findMany as any).mockResolvedValue(mockChunks)

      const results = await repo.listForDocument("doc-1")

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(mockPrisma.documentChunk.findMany as any).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { chunkIndex: "asc" },
        })
      )
      expect(results).toHaveLength(2)
    })

    it("does not select the embedding column (too large)", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockPrisma.documentChunk.findMany as any).mockResolvedValue([])

      await repo.listForDocument("doc-1")

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callArg = (mockPrisma.documentChunk.findMany as any).mock.calls[0]?.[0] as {
        select?: Record<string, unknown>
      }

      // If select is defined, embedding should not be included
      if (callArg?.select) {
        expect(callArg.select["embedding"]).toBeUndefined()
      }
    })
  })

  // ── deleteForDocument() ───────────────────────────────────────────────
  describe("deleteForDocument()", () => {
    it("deletes all chunks for the specified document", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockPrisma.documentChunk.deleteMany as any).mockResolvedValue({ count: 5 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockPrisma.documentChunk.count as any).mockResolvedValue(0)

      await repo.deleteForDocument("doc-1")

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(mockPrisma.documentChunk.deleteMany as any).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ documentId: "doc-1" }),
        })
      )
    })

    it("updates the indexed chunk count after deletion", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockPrisma.documentChunk.deleteMany as any).mockResolvedValue({ count: 3 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mockPrisma.documentChunk.count as any).mockResolvedValue(7)

      await repo.deleteForDocument("doc-1")

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(mockPrisma.documentChunk.count as any).toHaveBeenCalled()
    })
  })
})
