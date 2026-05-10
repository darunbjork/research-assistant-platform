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
import { RerankerService } from "../services/reranker.service"
import redis from "../utils/redis"

// ── Service Initialisation ────────────────────────────────────────────────
const prisma = new PrismaClient()
const embeddingService = new EmbeddingService(process.env.GEMINI_API_KEY ?? "", redis)
const hybridSearchService = new HybridSearchService(prisma, embeddingService)
const generationService = new GenerationService(process.env.GEMINI_API_KEY ?? "")
const rerankerService = new RerankerService(process.env.GEMINI_API_KEY ?? "")
const ragService = new RagService(hybridSearchService, generationService)

export class RagController {
  // ── POST /api/v1/rag/query ────────────────────────────────────────────
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

  // ── POST /api/v1/rag/query-with-rerank ────────────────────────────────
  queryWithRerank = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const { query, topK } = req.body as { query?: string; topK?: number }

      if (!query || typeof query !== "string" || query.trim() === "") {
        throw new ValidationError("Request body must include 'query'")
      }

      const start = Date.now()

      // Step 1: Hybrid search (retrieves more than needed)
      const hybridResults = await hybridSearchService.search(query.trim(), {
        topK: (topK ?? 5) * 2, // retrieve 2x for reranker to choose from
        userId: req.user.userId,
      })

      // Step 2: Rerank
      const reranked = await rerankerService.rerank(query.trim(), hybridResults, {
        topK: topK ?? 5,
      })

      // Step 3: Convert to HybridSearchResult shape for GenerationService
      const asHybrid = reranked.map(r => ({
        chunk: r.chunk,
        vectorRank: r.vectorRank,
        keywordRank: r.keywordRank,
        rrfScore: r.rerankScore, // use rerankScore as the ordering key
      }))

      // Step 4: Generate grounded answer
      const generation = await generationService.generate(query.trim(), asHybrid)

      res.status(200).json(
        ok({
          answer: generation.answer,
          citations: generation.citations,
          chunksRetrieved: hybridResults.length,
          chunksReranked: reranked.length,
          chunksUsed: generation.citations.length,
          tokensUsed: generation.tokensUsed,
          model: generation.model,
          durationMs: Date.now() - start,
          rerankingUsed: true,
        })
      )
    } catch (error: unknown) {
      next(error)
    }
  }
}
