// backend/src/__tests__/ingestion.service.test.ts
// Tests for IngestionService.
//
// KEY TESTING PRINCIPLE: Dependency Injection enables easy testing.
// IngestionService receives all its collaborators via constructor.
// In tests, we pass mock collaborators — no real database, no real API.
//
// The mocks implement the same interface as the real services,
// so IngestionService cannot tell the difference.

import { IngestionService } from "../services/ingestion.service"
import { ChunkingService } from "../services/chunking.service"
import type { DocumentRepository } from "../repositories/document.repository"
import type { ChunkRepository } from "../repositories/chunk.repository"
import type { EmbeddingService } from "../services/embedding.service"
import type { DocumentUploadRequest } from "../types"

// ── Mock Factories ────────────────────────────────────────────────────────

// Creates a mock EmbeddingService that returns fake 768-dim vectors instantly
function makeMockEmbeddingService(): jest.Mocked<EmbeddingService> {
  return {
    embedText: jest.fn().mockResolvedValue(Array(768).fill(0.1) as number[]),
    embedBatch: jest
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => Array(768).fill(0.1) as number[]))
      ),
    getCacheStats: jest.fn().mockReturnValue({ hits: 0, misses: 0, hitRate: 0 }),
  } as unknown as jest.Mocked<EmbeddingService>
}

// Creates a mock DocumentRepository
function makeMockDocumentRepository(): jest.Mocked<DocumentRepository> {
  return {
    create: jest.fn().mockResolvedValue({
      id: "doc-123",
      name: "test.txt",
      content: "test content",
      mimeType: "text/plain",
      sizeBytes: 100,
      userId: "user-456",
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    findById: jest.fn(),
    findByIdForUser: jest.fn(),
    listForUser: jest.fn().mockResolvedValue([]),
    countForUser: jest.fn().mockResolvedValue(0),
    deleteForUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<DocumentRepository>
}

// Creates a mock ChunkRepository
function makeMockChunkRepository(): jest.Mocked<ChunkRepository> {
  return {
    storeMany: jest.fn().mockResolvedValue(5),
    countForDocument: jest.fn().mockResolvedValue(5),
    deleteForDocument: jest.fn().mockResolvedValue(undefined),
    listForDocument: jest.fn().mockResolvedValue([]),
    getTotalCount: jest.fn().mockResolvedValue(5),
  } as unknown as jest.Mocked<ChunkRepository>
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const VALID_DOCUMENT: DocumentUploadRequest = {
  name: "machine-learning-intro.txt",
  content:
    "Machine learning is a subset of artificial intelligence. " +
    "It enables systems to learn from data without being explicitly programmed. " +
    "Supervised learning uses labelled training data. " +
    "Unsupervised learning finds patterns without labels. " +
    "Reinforcement learning uses rewards and penalties. " +
    "Deep learning uses neural networks with many layers. " +
    "Natural language processing enables machines to understand text.",
  mimeType: "text/plain",
  sizeBytes: 512,
}

const USER_ID = "user-test-456"

// ── Tests ─────────────────────────────────────────────────────────────────
describe("IngestionService", () => {
  let service: IngestionService
  let chunkingService: ChunkingService
  let embeddingService: jest.Mocked<EmbeddingService>
  let documentRepository: jest.Mocked<DocumentRepository>
  let chunkRepository: jest.Mocked<ChunkRepository>

  beforeEach(() => {
    // Real ChunkingService — it's pure logic, no external dependencies
    chunkingService = new ChunkingService()

    // Mock all external-dependency services
    embeddingService = makeMockEmbeddingService()
    documentRepository = makeMockDocumentRepository()
    chunkRepository = makeMockChunkRepository()

    service = new IngestionService(
      chunkingService,
      embeddingService,
      documentRepository,
      chunkRepository
    )
  })

  // ── Happy Path ─────────────────────────────────────────────────────────
  describe("ingest() — happy path", () => {
    it("returns a result with the correct documentId", async () => {
      const result = await service.ingest(VALID_DOCUMENT, USER_ID)
      expect(result.documentId).toBe("doc-123")
    })

    it("returns the correct document name", async () => {
      const result = await service.ingest(VALID_DOCUMENT, USER_ID)
      expect(result.name).toBe("machine-learning-intro.txt")
    })

    it("returns a positive chunkCount", async () => {
      const result = await service.ingest(VALID_DOCUMENT, USER_ID)
      expect(result.chunkCount).toBeGreaterThan(0)
    })

    it("returns a positive tokenCount", async () => {
      const result = await service.ingest(VALID_DOCUMENT, USER_ID)
      expect(result.tokenCount).toBeGreaterThan(0)
    })

    it("returns a positive durationMs", async () => {
      const result = await service.ingest(VALID_DOCUMENT, USER_ID)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it("calls documentRepository.create exactly once", async () => {
      await service.ingest(VALID_DOCUMENT, USER_ID)
      expect(documentRepository.create).toHaveBeenCalledTimes(1)
    })

    it("calls documentRepository.create with correct userId", async () => {
      await service.ingest(VALID_DOCUMENT, USER_ID)
      expect(documentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "machine-learning-intro.txt" }),
        USER_ID
      )
    })

    it("calls embeddingService.embedBatch once with all chunk texts", async () => {
      await service.ingest(VALID_DOCUMENT, USER_ID)
      expect(embeddingService.embedBatch).toHaveBeenCalledTimes(1)

      // embedBatch receives an array of strings (chunk texts)
      const [texts] = embeddingService.embedBatch.mock.calls[0] as [string[]]
      expect(Array.isArray(texts)).toBe(true)
      expect(texts.length).toBeGreaterThan(0)
    })

    it("uses RETRIEVAL_DOCUMENT task type for ingestion", async () => {
      await service.ingest(VALID_DOCUMENT, USER_ID)

      const [, taskType] = embeddingService.embedBatch.mock.calls[0] as [string[], string]
      expect(taskType).toBe("RETRIEVAL_DOCUMENT")
    })

    it("calls chunkRepository.storeMany with the document ID", async () => {
      await service.ingest(VALID_DOCUMENT, USER_ID)
      expect(chunkRepository.storeMany).toHaveBeenCalledWith("doc-123", expect.any(Array))
    })

    it("stores the same number of chunks as produced by chunking", async () => {
      await service.ingest(VALID_DOCUMENT, USER_ID)

      const [, storedChunks] = chunkRepository.storeMany.mock.calls[0] as [string, unknown[]]
      const result = await service.ingest(VALID_DOCUMENT, USER_ID)

      expect(storedChunks.length).toBe(result.chunkCount)
    })
  })

  // ── Validation ─────────────────────────────────────────────────────────
  describe("ingest() — validation", () => {
    it("throws ValidationError for empty name", async () => {
      await expect(service.ingest({ ...VALID_DOCUMENT, name: "" }, USER_ID)).rejects.toThrow(
        "Document name is required"
      )
    })

    it("throws ValidationError for whitespace-only name", async () => {
      await expect(service.ingest({ ...VALID_DOCUMENT, name: "   " }, USER_ID)).rejects.toThrow(
        "Document name is required"
      )
    })

    it("throws ValidationError for empty content", async () => {
      await expect(service.ingest({ ...VALID_DOCUMENT, content: "" }, USER_ID)).rejects.toThrow(
        "Document content cannot be empty"
      )
    })

    it("throws ValidationError for whitespace-only content", async () => {
      await expect(
        service.ingest({ ...VALID_DOCUMENT, content: "   \n\t  " }, USER_ID)
      ).rejects.toThrow("Document content cannot be empty")
    })

    it("throws ValidationError for missing mimeType", async () => {
      await expect(service.ingest({ ...VALID_DOCUMENT, mimeType: "" }, USER_ID)).rejects.toThrow(
        "Document mimeType is required"
      )
    })

    it("throws ValidationError when content exceeds maxDocumentSize", async () => {
      const hugeContent = "A".repeat(600_000) // > 500,000 char limit

      await expect(
        service.ingest({ ...VALID_DOCUMENT, content: hugeContent }, USER_ID)
      ).rejects.toThrow("Document exceeds maximum size")
    })

    it("does not call any repository when validation fails", async () => {
      await expect(service.ingest({ ...VALID_DOCUMENT, name: "" }, USER_ID)).rejects.toThrow()

      expect(documentRepository.create).not.toHaveBeenCalled()
      expect(embeddingService.embedBatch).not.toHaveBeenCalled()
      expect(chunkRepository.storeMany).not.toHaveBeenCalled()
    })
  })

  // ── Error Recovery ─────────────────────────────────────────────────────
  describe("ingest() — error recovery", () => {
    it("cleans up document if embedding fails", async () => {
      // Simulate Gemini API being down
      embeddingService.embedBatch.mockRejectedValueOnce(new Error("Gemini API unavailable"))

      await expect(service.ingest(VALID_DOCUMENT, USER_ID)).rejects.toThrow(
        "Gemini API unavailable"
      )

      // The document created in step 1 should be cleaned up
      expect(documentRepository.deleteForUser).toHaveBeenCalledWith("doc-123", USER_ID)
    })

    it("cleans up chunks if storage fails", async () => {
      chunkRepository.storeMany.mockRejectedValueOnce(new Error("pgvector storage error"))

      await expect(service.ingest(VALID_DOCUMENT, USER_ID)).rejects.toThrow(
        "pgvector storage error"
      )

      // Both chunks and document should be cleaned up
      expect(chunkRepository.deleteForDocument).toHaveBeenCalled()
      expect(documentRepository.deleteForUser).toHaveBeenCalled()
    })
  })

  // ── Pipeline Order ──────────────────────────────────────────────────────
  describe("ingest() — operation order", () => {
    it("creates document BEFORE embedding", async () => {
      const callOrder: string[] = []

      documentRepository.create.mockImplementation(async (..._args) => {
        callOrder.push("create")
        return {
          id: "doc-123",
          name: "test",
          content: "test",
          mimeType: "text/plain",
          sizeBytes: 100,
          userId: USER_ID,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      })

      embeddingService.embedBatch.mockImplementation(async (texts: string[]) => {
        callOrder.push("embed")
        return texts.map(() => Array(768).fill(0.1) as number[])
      })

      chunkRepository.storeMany.mockImplementation(async () => {
        callOrder.push("store")
        return 5
      })

      await service.ingest(VALID_DOCUMENT, USER_ID)

      expect(callOrder).toEqual(["create", "embed", "store"])
    })
  })
})
