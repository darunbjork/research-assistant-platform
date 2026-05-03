// backend/src/repositories/document.repository.ts
// Handles all database operations for the Document table.
//
// WHAT THE REPOSITORY PATTERN IS:
// A repository is a layer between your service and the database.
// Services call repository methods — they never write raw SQL or Prisma calls.
//
// WHY THIS SEPARATION EXISTS:
// If you later switch from Prisma to raw SQL, or from PostgreSQL
// to a different database, you only change the repository.
// The IngestionService does not know or care HOW documents are stored —
// only that they ARE stored.
//
// MERN ANALOGY:
// Like a Mongoose model with its own helper methods,
// but completely decoupled from the HTTP layer.

import type { PrismaClient, Document } from "@prisma/client"
import { NotFoundError } from "../middleware/error.middleware"
import { logRagEvent } from "../utils/logger"
import type { DocumentUploadRequest } from "../types"

// ── Types ─────────────────────────────────────────────────────────────────

// What we store about each document — without the raw content
// (content can be large — we don't always need to return it)
export interface DocumentSummary {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  userId: string
  createdAt: Date
  updatedAt: Date
  chunkCount?: number // populated by join queries
}

// Filters for listing documents
export interface DocumentListOptions {
  userId: string
  limit?: number
  offset?: number
}

export class DocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ── Create ────────────────────────────────────────────────────────────
  // Called by IngestionService after receiving an upload.
  // Stores the document metadata + full content.
  async create(data: DocumentUploadRequest, userId: string): Promise<Document> {
    const start = Date.now()

    const document = await this.prisma.document.create({
      data: {
        name: data.name,
        content: data.content,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        userId,
      },
    })

    logRagEvent("ingest", "Document created in database", {
      service: "DocumentRepository",
      documentId: document.id,
      durationMs: Date.now() - start,
    })

    return document
  }

  // ── Find by ID ────────────────────────────────────────────────────────
  // Used when retrieving a document for display or re-ingestion.
  // Throws NotFoundError if the document does not exist.
  async findById(documentId: string): Promise<Document> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
    })

    if (document === null) {
      throw new NotFoundError(`Document ${documentId}`)
    }

    return document
  }

  // ── Find by ID — enforce user ownership ──────────────────────────────
  // DATA ISOLATION: Users must never access other users' documents.
  // This query adds WHERE userId = ? to the find — not just WHERE id = ?
  // Even if someone guesses a document ID, they cannot access it
  // unless it belongs to their account.
  async findByIdForUser(documentId: string, userId: string): Promise<Document> {
    const document = await this.prisma.document.findFirst({
      where: {
        id: documentId,
        userId, // ← enforces ownership
      },
    })

    if (document === null) {
      // Return NotFound — not Forbidden.
      // Returning "forbidden" would confirm the document exists,
      // which leaks information to an attacker.
      throw new NotFoundError("Document")
    }

    return document
  }

  // ── List for User ─────────────────────────────────────────────────────
  // Returns all documents owned by a user with pagination.
  // Also returns chunk count via _count so the UI can show "42 chunks indexed".
  async listForUser(options: DocumentListOptions): Promise<DocumentSummary[]> {
    const limit = options.limit ?? 20
    const offset = options.offset ?? 0

    const documents = await this.prisma.document.findMany({
      where: { userId: options.userId },
      select: {
        id: true,
        name: true,
        mimeType: true,
        sizeBytes: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { chunks: true }, // count related DocumentChunk rows
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    })

    return documents.map(doc => ({
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      chunkCount: doc._count.chunks,
    }))
  }

  // ── Count for User ────────────────────────────────────────────────────
  async countForUser(userId: string): Promise<number> {
    return this.prisma.document.count({
      where: { userId },
    })
  }

  // ── Delete ────────────────────────────────────────────────────────────
  // Deletes a document AND all its chunks (cascade delete in schema).
  // Validates ownership before deleting — users can only delete their own docs.
  async deleteForUser(documentId: string, userId: string): Promise<void> {
    // Verify it exists and belongs to this user (throws NotFoundError if not)
    await this.findByIdForUser(documentId, userId)

    await this.prisma.document.delete({
      where: { id: documentId },
    })

    logRagEvent("ingest", "Document deleted", {
      service: "DocumentRepository",
      documentId,
    })
  }
}
