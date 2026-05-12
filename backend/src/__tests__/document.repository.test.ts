// backend/src/__tests__/document.repository.test.ts
// Tests for DocumentRepository — the database layer for documents.

import { DocumentRepository } from "../repositories/document.repository"
import { makeMockPrismaClient } from "./helpers/mock-factories"
import type { DocumentUploadRequest } from "../types"

const SAMPLE_UPLOAD: DocumentUploadRequest = {
  name: "test-report.txt",
  content: "This is the document content.",
  mimeType: "text/plain",
  sizeBytes: 30,
}

const SAMPLE_DOCUMENT = {
  id: "doc-001",
  name: "test-report.txt",
  content: "This is the document content.",
  mimeType: "text/plain",
  sizeBytes: 30,
  userId: "user-001",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
}

describe("DocumentRepository", () => {
  let repo: DocumentRepository
  let mockPrisma: ReturnType<typeof makeMockPrismaClient>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any

  beforeEach(() => {
    mockPrisma = makeMockPrismaClient()
    p = mockPrisma
    repo = new DocumentRepository(mockPrisma)
  })

  // ── create() ──────────────────────────────────────────────────────────
  describe("create()", () => {
    it("creates a document with correct data", async () => {
      p.document.create.mockResolvedValue(SAMPLE_DOCUMENT)

      await repo.create(SAMPLE_UPLOAD, "user-001")

      expect(p.document.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "test-report.txt",
            content: "This is the document content.",
            userId: "user-001",
          }),
        })
      )
    })

    it("returns the created document", async () => {
      p.document.create.mockResolvedValue(SAMPLE_DOCUMENT)

      const result = await repo.create(SAMPLE_UPLOAD, "user-001")
      expect(result.id).toBe("doc-001")
    })
  })

  // ── findById() ────────────────────────────────────────────────────────
  describe("findById()", () => {
    it("returns document when found", async () => {
      p.document.findUnique.mockResolvedValue(SAMPLE_DOCUMENT)

      const result = await repo.findById("doc-001")
      expect(result.id).toBe("doc-001")
    })

    it("throws NotFoundError when document does not exist", async () => {
      p.document.findUnique.mockResolvedValue(null)

      await expect(repo.findById("nonexistent")).rejects.toThrow("not found")
    })
  })

  // ── findByIdForUser() ─────────────────────────────────────────────────
  describe("findByIdForUser()", () => {
    it("returns document when it belongs to the user", async () => {
      p.document.findFirst.mockResolvedValue(SAMPLE_DOCUMENT)

      const result = await repo.findByIdForUser("doc-001", "user-001")
      expect(result.id).toBe("doc-001")
    })

    it("queries with BOTH documentId AND userId", async () => {
      p.document.findFirst.mockResolvedValue(SAMPLE_DOCUMENT)

      await repo.findByIdForUser("doc-001", "user-001")

      expect(p.document.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "doc-001",
            userId: "user-001",
          }),
        })
      )
    })

    it("throws NotFoundError when document belongs to different user", async () => {
      p.document.findFirst.mockResolvedValue(null)

      await expect(repo.findByIdForUser("doc-001", "wrong-user")).rejects.toThrow("not found")
    })
  })

  // ── listForUser() ─────────────────────────────────────────────────────
  describe("listForUser()", () => {
    it("returns an array of document summaries", async () => {
      p.document.findMany.mockResolvedValue([
        {
          ...SAMPLE_DOCUMENT,
          _count: { chunks: 5 },
        },
      ])

      const results = await repo.listForUser({ userId: "user-001" })
      expect(Array.isArray(results)).toBe(true)
    })

    it("queries only documents belonging to the user", async () => {
      p.document.findMany.mockResolvedValue([])

      await repo.listForUser({ userId: "user-001" })

      expect(p.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: "user-001" }),
        })
      )
    })

    it("includes chunk count in the result", async () => {
      p.document.findMany.mockResolvedValue([
        {
          ...SAMPLE_DOCUMENT,
          _count: { chunks: 42 },
        },
      ])

      const results = await repo.listForUser({ userId: "user-001" })
      expect(results[0]?.chunkCount).toBe(42)
    })

    it("returns empty array when user has no documents", async () => {
      p.document.findMany.mockResolvedValue([])

      const results = await repo.listForUser({ userId: "user-no-docs" })
      expect(results).toHaveLength(0)
    })
  })

  // ── deleteForUser() ───────────────────────────────────────────────────
  describe("deleteForUser()", () => {
    it("deletes the document when user owns it", async () => {
      p.document.findFirst.mockResolvedValue(SAMPLE_DOCUMENT)
      p.document.delete.mockResolvedValue(SAMPLE_DOCUMENT)

      await repo.deleteForUser("doc-001", "user-001")

      expect(p.document.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "doc-001" },
        })
      )
    })

    it("throws NotFoundError when document belongs to different user", async () => {
      p.document.findFirst.mockResolvedValue(null)

      await expect(repo.deleteForUser("doc-001", "wrong-user")).rejects.toThrow("not found")

      // Should not delete if ownership check fails
      expect(p.document.delete).not.toHaveBeenCalled()
    })
  })
})
