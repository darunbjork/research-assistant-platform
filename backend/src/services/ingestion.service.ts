// backend/src/services/ingestion.service.ts
// Orchestrates the full document ingestion pipeline:
//   1. Validate the input document
//   2. Create a Document row in PostgreSQL
//   3. Chunk the document text (ChunkingService)
//   4. Embed all chunks in one batch call (EmbeddingService)
//   5. Store chunks + vectors in pgvector (ChunkRepository)
//   6. Return a summary of what was ingested
//
// THIS SERVICE:
//   - Has no knowledge of HTTP (no req, no res)
//   - Takes plain objects in, returns plain objects out
//   - Is fully testable by injecting mock services
//   - Uses dependency injection for all collaborators

import type { ChunkingService } from "./chunking.service"
import type { EmbeddingService } from "./embedding.service"
import type { DocumentRepository } from "../repositories/document.repository"
import type { ChunkRepository } from "../repositories/chunk.repository"
import type { DocumentUploadRequest, ChunkingStrategy } from "../types"
import type { ChunkToStore } from "../repositories/chunk.repository"
import { logRagEvent, logError } from "../utils/logger"
import { RAGError, ValidationError } from "../middleware/error.middleware"

// ── Configuration ─────────────────────────────────────────────────────────
export interface IngestionConfig {
  chunkingStrategy: ChunkingStrategy // which strategy to use
  chunkSize: number // characters per chunk (for fixed strategy)
  overlap: number // overlap between chunks
  maxDocumentSize: number // max characters (reject very large docs)
}

const DEFAULT_CONFIG: IngestionConfig = {
  chunkingStrategy: "recursive", // best general-purpose strategy
  chunkSize: 512, // ~128 tokens per chunk
  overlap: 50, // ~12 tokens of overlap
  maxDocumentSize: 500_000, // ~125,000 tokens max (~200 pages)
}

// ── Result Types ──────────────────────────────────────────────────────────
export interface IngestionResult {
  documentId: string
  name: string
  chunkCount: number
  tokenCount: number // total estimated tokens across all chunks
  strategy: ChunkingStrategy
  durationMs: number
  warnings: string[] // from ChunkingService.validateChunks()
}

export class IngestionService {
  constructor(
    private readonly chunkingService: ChunkingService,
    private readonly embeddingService: EmbeddingService,
    private readonly documentRepository: DocumentRepository,
    private readonly chunkRepository: ChunkRepository,
    private readonly config: IngestionConfig = DEFAULT_CONFIG
  ) {}

  // ── ingest ────────────────────────────────────────────────────────────
  // The main entry point. Takes a document upload request and a userId.
  // Runs the full pipeline and returns a summary.
  async ingest(data: DocumentUploadRequest, userId: string): Promise<IngestionResult> {
    const pipelineStart = Date.now()

    logRagEvent("ingest", "Starting document ingestion", {
      service: "IngestionService",
      userId,
      name: data.name,
      sizeBytes: data.sizeBytes,
    })

    // ── Step 0: Validate ────────────────────────────────────────────────
    this.validateInput(data)

    // ── Step 1: Create Document row ─────────────────────────────────────
    let document
    try {
      document = await this.documentRepository.create(data, userId)
    } catch (error: unknown) {
      logError("Ingestion failed at document creation", error, {
        service: "IngestionService",
        userId,
      })
      throw new RAGError("Failed to create document record", "ingestion" as never)
    }

    const documentId = document.id

    try {
      // ── Step 2: Chunk the document ────────────────────────────────────
      const chunkStart = Date.now()

      const rawChunks = this.chunkingService.chunk(data.content, this.config.chunkingStrategy, {
        maxChunkSize: this.config.chunkSize,
        overlap: this.config.overlap,
      })

      // Warn about quality issues but continue — do not fail ingestion for warnings
      const warnings = this.chunkingService.validateChunks(rawChunks)
      if (warnings.length > 0) {
        warnings.forEach(warning =>
          logRagEvent("chunk", `Chunk warning: ${warning}`, {
            service: "IngestionService",
            documentId,
          })
        )
      }

      if (rawChunks.length === 0) {
        throw new RAGError(
          "Document produced zero chunks — content may be empty or whitespace only",
          "chunking" as never
        )
      }

      logRagEvent("chunk", "Document chunked successfully", {
        service: "IngestionService",
        documentId,
        chunkCount: rawChunks.length,
        durationMs: Date.now() - chunkStart,
      })

      // ── Step 3: Embed all chunks ──────────────────────────────────────
      const embedStart = Date.now()
      const chunkTexts = rawChunks.map(c => c.content)

      // All chunks embedded in one batched API call (with Redis cache)
      // This is the most expensive step — Gemini API call
      const embeddings = await this.embeddingService.embedBatch(
        chunkTexts,
        "RETRIEVAL_DOCUMENT" // task type for document storage
      )

      logRagEvent("embed", "All chunks embedded", {
        service: "IngestionService",
        documentId,
        chunkCount: rawChunks.length,
        durationMs: Date.now() - embedStart,
      })

      // ── Step 4: Build ChunkToStore objects ────────────────────────────
      // Merge rawChunks (from ChunkingService) with embeddings (from EmbeddingService)
      // into the shape ChunkRepository.storeMany() expects
      const chunksToStore: ChunkToStore[] = rawChunks.map((rawChunk, index) => {
        const embedding = embeddings[index]

        // This should never happen — embedBatch validates count matching
        // But we guard here for TypeScript safety
        if (embedding === undefined) {
          throw new RAGError(
            `Missing embedding for chunk ${index} — batch count mismatch`,
            "embedding" as never
          )
        }

        return {
          content: rawChunk.content,
          chunkIndex: rawChunk.chunkIndex,
          tokenCount: rawChunk.tokenCount,
          embedding,
          metadata: {
            source: data.name, // filename shown in citations
            chunkingStrategy: this.config.chunkingStrategy,
            characterCount: rawChunk.characterCount,
            pageNumber: undefined, // populated from PDF parser in future
          },
        }
      })

      // ── Step 5: Store chunks in pgvector ─────────────────────────────
      const storeStart = Date.now()

      await this.chunkRepository.storeMany(documentId, chunksToStore)

      logRagEvent("ingest", "Chunks stored in pgvector", {
        service: "IngestionService",
        documentId,
        chunkCount: chunksToStore.length,
        durationMs: Date.now() - storeStart,
      })

      // ── Step 6: Build result summary ──────────────────────────────────
      const totalTokens = rawChunks.reduce((sum, c) => sum + c.tokenCount, 0)
      const totalMs = Date.now() - pipelineStart

      logRagEvent("ingest", "Ingestion pipeline complete", {
        service: "IngestionService",
        documentId,
        chunkCount: rawChunks.length,
        tokenCount: totalTokens,
        durationMs: totalMs,
      })

      return {
        documentId,
        name: data.name,
        chunkCount: rawChunks.length,
        tokenCount: totalTokens,
        strategy: this.config.chunkingStrategy,
        durationMs: totalMs,
        warnings,
      }
    } catch (error: unknown) {
      // If ingestion fails after the document was created,
      // clean up the orphaned document row + any partial chunks
      logError("Ingestion pipeline failed — cleaning up", error, {
        service: "IngestionService",
        documentId,
      })

      // Best-effort cleanup — do not throw if cleanup also fails
      try {
        await this.chunkRepository.deleteForDocument(documentId)
        await this.documentRepository.deleteForUser(documentId, userId)
      } catch (cleanupError: unknown) {
        logError("Cleanup after failed ingestion also failed", cleanupError, {
          service: "IngestionService",
          documentId,
        })
      }

      // Re-throw the original error
      if (error instanceof Error) throw error
      throw new RAGError("Ingestion pipeline failed", "ingestion" as never)
    }
  }

  // ── validateInput ─────────────────────────────────────────────────────
  private validateInput(data: DocumentUploadRequest): void {
    if (!data.name || data.name.trim() === "") {
      throw new ValidationError("Document name is required")
    }

    if (!data.content || data.content.trim() === "") {
      throw new ValidationError("Document content cannot be empty")
    }

    if (data.content.length > this.config.maxDocumentSize) {
      throw new ValidationError(
        `Document exceeds maximum size of ${this.config.maxDocumentSize} characters. ` +
          `Received: ${data.content.length} characters.`
      )
    }

    if (!data.mimeType || data.mimeType.trim() === "") {
      throw new ValidationError("Document mimeType is required")
    }
  }
}
