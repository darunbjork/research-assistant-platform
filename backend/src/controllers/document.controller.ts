// backend/src/controllers/document.controller.ts
// HTTP layer for document operations.
// Parses the request → calls IngestionService → returns the result.
// No business logic here — that all lives in IngestionService.

import type { Request, Response, NextFunction } from "express"
import { PrismaClient } from "@prisma/client"
import { ChunkingService } from "../services/chunking.service"
import { EmbeddingService } from "../services/embedding.service"
import { IngestionService } from "../services/ingestion.service"
import { DocumentRepository } from "../repositories/document.repository"
import { ChunkRepository } from "../repositories/chunk.repository"
import { ok } from "../types"
import { redis } from "../utils/redis"
import { ValidationError } from "../middleware/error.middleware"

// ── Service Initialisation ────────────────────────────────────────────────
// In a production app, these would be injected via a DI container (e.g. tsyringe).
// For clarity, we initialise them directly in the controller file.
// All services share one Prisma instance and one Redis instance.
const prisma = new PrismaClient()
const chunkingService = new ChunkingService()
const embeddingService = new EmbeddingService(process.env.GEMINI_API_KEY ?? "", redis)
const documentRepository = new DocumentRepository(prisma)
const chunkRepository = new ChunkRepository(prisma)
const ingestionService = new IngestionService(
  chunkingService,
  embeddingService,
  documentRepository,
  chunkRepository
)

export class DocumentController {
  // ── POST /api/v1/documents/ingest ──────────────────────────────────────
  // Accepts plain text content in the request body.
  // In a future iteration (Day 19), this will accept actual file uploads.
  // For now: send { name, content, mimeType } as JSON.
  ingest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // authMiddleware guarantees req.user exists on this route
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      // Safely extract and normalize name, content, and mimeType from req.body
      // Handles cases where fields might be provided as string or string[]
      const {
        name: rawName,
        content: rawContent,
        mimeType: rawMimeType,
      } = req.body as {
        name?: string | string[]
        content?: string | string[]
        mimeType?: string | string[]
      }

      const name =
        typeof rawName === "string" ? rawName : Array.isArray(rawName) ? rawName[0] : undefined
      const content =
        typeof rawContent === "string"
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent[0]
            : undefined
      const mimeType =
        typeof rawMimeType === "string"
          ? rawMimeType
          : Array.isArray(rawMimeType)
            ? rawMimeType[0]
            : undefined

      // Basic shape check — now checking if they are defined strings
      if (!name || !content || !mimeType) {
        throw new ValidationError(
          "Request body must include: name (string), content (string), mimeType (string)"
        )
      }

      const result = await ingestionService.ingest(
        {
          name: name.trim(),
          content,
          mimeType: mimeType.trim(),
          sizeBytes: Buffer.byteLength(content, "utf8"),
        },
        req.user.userId
      )

      // 202 Accepted — ingestion happened synchronously here.
      // On Day 19, this becomes async (Bull queue) and returns 202 immediately.
      res.status(202).json(ok(result))
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── GET /api/v1/documents ─────────────────────────────────────────────
  // Lists all documents for the authenticated user with pagination.
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const limit = Math.min(parseInt((req.query["limit"] as string) ?? "20"), 100)
      const offset = Math.max(parseInt((req.query["offset"] as string) ?? "0"), 0)

      const [documents, total] = await Promise.all([
        documentRepository.listForUser({
          userId: req.user.userId,
          limit,
          offset,
        }),
        documentRepository.countForUser(req.user.userId),
      ])

      res.status(200).json(ok(documents, { total, limit, page: Math.floor(offset / limit) + 1 }))
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── GET /api/v1/documents/:id ─────────────────────────────────────────
  // Returns one document's metadata and its list of chunks (without vectors).
  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const id = req.params.id as string
      const userId = req.user?.userId as string

      if (!id || !userId) {
        throw new ValidationError("Missing ID or User")
      }

      // findByIdForUser enforces ownership — throws NotFoundError if not theirs
      const document = await documentRepository.findByIdForUser(id, userId)
      const chunks = await chunkRepository.listForDocument(id)

      res.status(200).json(
        ok({
          ...document,
          chunks: chunks.map(c => ({
            id: c.id,
            chunkIndex: c.chunkIndex,
            tokenCount: c.tokenCount,
            content: c.content.slice(0, 200) + (c.content.length > 200 ? "..." : ""),
            // Truncate content preview — full content available on chunk detail endpoint
          })),
        })
      )
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── DELETE /api/v1/documents/:id ──────────────────────────────────────
  // Deletes a document and all its chunks from pgvector.
  delete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const id = req.params.id as string
      // userId is guaranteed to be a string by authMiddleware, but we cast it for type safety.
      const userId = req.user!.userId as string

      if (!id) {
        // This check might be redundant if casting id, but keep for now to match original logic.
        throw new ValidationError("Document ID is required")
      }

      await documentRepository.deleteForUser(id, userId)

      // 204 No Content — successful delete with no body
      res.status(204).send()
    } catch (error: unknown) {
      next(error)
    }
  }
}
