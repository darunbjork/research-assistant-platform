// backend/src/controllers/rag.controller.ts
// HTTP layer for the RAG pipeline.
// Parses the request → calls RagService → returns the answer with citations.

import type { Request, Response, NextFunction } from "express"
import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { GenerationService } from "../services/generation.service"
import { RagService } from "../services/rag.service"
import { ValidationError } from "../middleware/error.middleware"
import { ok } from "../types"
import redis from "../utils/redis"

// ── Service Initialisation ────────────────────────────────────────────────
const prisma = new PrismaClient()
const embeddingService = new EmbeddingService(process.env.GEMINI_API_KEY ?? "", redis)
const hybridSearchService = new HybridSearchService(prisma, embeddingService)
const generationService = new GenerationService(process.env.GEMINI_API_KEY ?? "")
const ragService = new RagService(hybridSearchService, generationService)

export class RagController {
  // ── POST /api/v1/rag/query ────────────────────────────────────────────
  // The primary RAG endpoint.
  // Body: { query: string, topK?: number, minSimilarity?: number }
  // Returns: { answer, citations, metadata }
  query = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const { query, topK, minSimilarity, documentIds } = req.body as {
        query?: string
        topK?: number
        minSimilarity?: number
        documentIds?: string[]
      }

      if (!query || typeof query !== "string" || query.trim() === "") {
        throw new ValidationError("Request body must include 'query' (non-empty string)")
      }

      const result = await ragService.query(query.trim(), {
        topK: topK ?? 10,
        minSimilarity: minSimilarity ?? 0.0,
        userId: req.user.userId,
        documentIds: documentIds ?? [],
      })

      res.status(200).json(ok(result))
    } catch (error: unknown) {
      next(error)
    }
  }
}
