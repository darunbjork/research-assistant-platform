// backend/src/controllers/document.controller.ts
// Updated Day 19: ingest() adds to Bull Queue and returns immediately.

import type { Request, Response, NextFunction } from "express"
import { PrismaClient } from "@prisma/client"
import { getIngestionQueue, getJobStatus } from "../queue/index"
import { ValidationError } from "../middleware/error.middleware"
import { ok } from "../types"
import { searchCache } from "../cache/index"

const prisma = new PrismaClient()

export class DocumentController {
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

      if (content.length > 500_000) {
        throw new ValidationError(
          `Document exceeds maximum size of 500,000 characters. Received: ${content.length}`
        )
      }

      const queue = getIngestionQueue()

      const job = await queue.add({
        name: name.trim(),
        content,
        mimeType: mimeType.trim(),
        sizeBytes: Buffer.byteLength(content, "utf8"),
        userId: req.user.userId,
        requestId: `req-${Date.now()}`,
      })

      res.status(202).json(
        ok({
          jobId: String(job.id),
          status: "queued",
          message:
            "Document queued for ingestion. Poll GET /api/v1/documents/jobs/:jobId for status.",
          name: name.trim(),
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
      const status = await getJobStatus(queue, jobId)

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
