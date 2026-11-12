// backend/src/controllers/document.controller.ts
// Updated Day 19: ingest() adds to Bull Queue and returns immediately.

import type { Request, Response, NextFunction } from "express"
import { prisma } from "../utils/prisma"
import { getIngestionQueue, getJobStatus } from "../queue/index"
import { ValidationError } from "../middleware/error.middleware"
import { ok } from "../types"
import { searchCache } from "../cache/index"
import { extractText } from "../services/text-extraction.service"

const MAX_DOCUMENT_CHARS = 500_000
const INGEST_QUEUED_MESSAGE =
  "Document queued for ingestion. Poll GET /api/v1/documents/jobs/:jobId for status."

export class DocumentController {
  /** Shared queue path for POST /ingest (JSON) and POST /upload (multipart). */
  private async enqueueDocument(
    userId: string,
    doc: { name: string; content: string; mimeType: string }
  ): Promise<{ jobId: string; name: string }> {
    const queue = getIngestionQueue()
    const job = await queue.add({
      name: doc.name,
      content: doc.content,
      mimeType: doc.mimeType,
      sizeBytes: Buffer.byteLength(doc.content, "utf8"),
      userId,
      requestId: `req-${Date.now()}`,
    })
    return { jobId: String(job.id), name: doc.name }
  }

  // ── POST /api/v1/documents/ingest ─────────────────────────────────────
  ingest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const { name, content, mimeType } = req.body as {
        name?: string
        content?: string
        mimeType?: string
      }

      if (!name || !content || !mimeType) {
        throw new ValidationError(
          "Request body must include: name (string), content (string), mimeType (string)"
        )
      }

      if (content.length > MAX_DOCUMENT_CHARS) {
        throw new ValidationError(
          `Document exceeds maximum size of 500,000 characters. Received: ${content.length}`
        )
      }

      const { jobId, name: trimmedName } = await this.enqueueDocument(req.user.userId, {
        name: name.trim(),
        content,
        mimeType: mimeType.trim(),
      })

      res.status(202).json(
        ok({
          jobId,
          status: "queued",
          message: INGEST_QUEUED_MESSAGE,
          name: trimmedName,
        })
      )
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── POST /api/v1/documents/upload (multipart, task 4.1) ───────────────
  upload = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const file = req.file
      if (!file) {
        throw new ValidationError(
          "Missing file — send the file under the 'file' field (multipart/form-data)"
        )
      }

      const { text } = await extractText(file.buffer, file.mimetype, file.originalname)

      if (text.length > MAX_DOCUMENT_CHARS) {
        throw new ValidationError(
          `Document exceeds maximum size of 500,000 characters. Received: ${text.length}`
        )
      }

      const name = file.originalname.trim() || "untitled"
      const { jobId } = await this.enqueueDocument(req.user.userId, {
        name,
        content: text,
        mimeType: file.mimetype || "application/octet-stream",
      })

      res.status(202).json(
        ok({
          jobId,
          status: "queued",
          message: INGEST_QUEUED_MESSAGE,
          name,
        })
      )
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── GET /api/v1/documents/jobs/:jobId ─────────────────────────────────
  getJobStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const jobId = req.params.jobId as string

      if (!jobId) {
        throw new ValidationError("jobId parameter is required")
      }

      const queue = getIngestionQueue()
      const status = await getJobStatus(queue, jobId, req.user.userId)

      if (status === null) {
        res.status(404).json({
          success: false,
          data: null,
          error: `Job ${jobId} not found. Jobs are retained for 24 hours after completion.`,
        })
        return
      }

      res.status(200).json(ok(status))
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── GET /api/v1/documents ─────────────────────────────────────────────
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const limit = Math.min(parseInt((req.query["limit"] as string) ?? "20"), 100)
      const offset = Math.max(parseInt((req.query["offset"] as string) ?? "0"), 0)

      const { DocumentRepository } = await import("../repositories/document.repository")
      const documentRepository = new DocumentRepository(prisma)

      const [documents, total] = await Promise.all([
        documentRepository.listForUser({
          userId: req.user.userId,
          limit,
          offset,
        }),
        documentRepository.countForUser(req.user.userId),
      ])

      res.status(200).json(
        ok(documents, {
          total,
          limit,
          page: Math.floor(offset / limit) + 1,
        })
      )
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── GET /api/v1/documents/:id ─────────────────────────────────────────
  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const id = req.params.id as string
      if (!id) throw new ValidationError("Document ID is required")

      const { DocumentRepository } = await import("../repositories/document.repository")
      const { ChunkRepository } = await import("../repositories/chunk.repository")
      const documentRepository = new DocumentRepository(prisma)
      const chunkRepository = new ChunkRepository(prisma)

      const document = await documentRepository.findByIdForUser(id, req.user.userId)
      const chunks = await chunkRepository.listForDocument(id)

      res.status(200).json(
        ok({
          ...document,
          chunks: chunks.map(c => ({
            id: c.id,
            chunkIndex: c.chunkIndex,
            tokenCount: c.tokenCount,
            content: c.content.slice(0, 200) + (c.content.length > 200 ? "..." : ""),
          })),
        })
      )
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── DELETE /api/v1/documents/:id ──────────────────────────────────────
  delete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const id = req.params.id as string
      if (!id) throw new ValidationError("Document ID is required")

      const { DocumentRepository } = await import("../repositories/document.repository")
      const documentRepository = new DocumentRepository(prisma)

      await documentRepository.deleteForUser(id, req.user.userId)
      await searchCache.invalidateForUser(req.user.userId)

      res.status(204).send()
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── GET /api/v1/documents/cache/stats ────────────────────────────────
  cacheStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const stats = searchCache.getStats()
      res.status(200).json(
        ok({
          searchCache: {
            ...stats,
            hitRatePercent: `${(stats.hitRate * 100).toFixed(1)}%`,
          },
        })
      )
    } catch (error: unknown) {
      next(error)
    }
  }
}
