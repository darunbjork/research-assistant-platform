// backend/src/controllers/eval.controller.ts
// HTTP layer for the evaluation endpoints.
//
// ENDPOINTS:
//   POST /api/v1/eval/score    — evaluate one query-answer pair
//   POST /api/v1/eval/batch    — evaluate multiple pairs
//   GET  /api/v1/eval/summary  — aggregate scores from Prometheus

import type { Request, Response, NextFunction } from "express"
import { EvaluatorService } from "../services/evaluator.service"
import { ValidationError } from "../middleware/error.middleware"
import { ok } from "../types"
import type { EvalRequest, BatchEvalRequest } from "../types/eval.types"

const evaluatorService = new EvaluatorService(process.env.GEMINI_API_KEY ?? "")

export class EvalController {
  // ── POST /api/v1/eval/score ───────────────────────────────────────────
  score = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as Partial<EvalRequest>

      if (!body.query || typeof body.query !== "string" || body.query.trim() === "") {
        throw new ValidationError("'query' is required and must be a non-empty string")
      }

      if (!Array.isArray(body.retrievedContext) || body.retrievedContext.length === 0) {
        throw new ValidationError("'retrievedContext' must be a non-empty array of strings")
      }

      if (!body.answer || typeof body.answer !== "string" || body.answer.trim() === "") {
        throw new ValidationError("'answer' is required and must be a non-empty string")
      }

      const result = await evaluatorService.evaluate({
        query: body.query.trim(),
        retrievedContext: body.retrievedContext,
        answer: body.answer.trim(),
        documentIds: body.documentIds,
        pipelineVersion: body.pipelineVersion,
      })

      res.status(200).json(ok(result))
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── POST /api/v1/eval/batch ───────────────────────────────────────────
  batch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as Partial<BatchEvalRequest>

      if (!Array.isArray(body.pairs) || body.pairs.length === 0) {
        throw new ValidationError(
          "'pairs' must be a non-empty array of {query, retrievedContext, answer}"
        )
      }

      if (body.pairs.length > 20) {
        throw new ValidationError("Batch size cannot exceed 20 pairs (API rate limit protection)")
      }

      // Validate each pair
      body.pairs.forEach((pair, i) => {
        if (!pair.query || !Array.isArray(pair.retrievedContext) || !pair.answer) {
          throw new ValidationError(
            `Pair at index ${i} must have: query (string), retrievedContext (string[]), answer (string)`
          )
        }
      })

      const result = await evaluatorService.evaluateBatch({
        pairs: body.pairs,
        pipelineVersion: body.pipelineVersion,
      })

      res.status(200).json(ok(result))
    } catch (error: unknown) {
      next(error)
    }
  }

  // ── GET /api/v1/eval/summary ──────────────────────────────────────────
  // Returns aggregate evaluation stats from the in-memory store.
  // In production: query a database table of stored evaluations.
  summary = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Return a summary of what the eval endpoint provides
      // Real implementation would query stored evaluations from database
      res.status(200).json(
        ok({
          description: "RAG Triad evaluation endpoint",
          endpoints: {
            score: "POST /api/v1/eval/score — evaluate one query-answer pair",
            batch: "POST /api/v1/eval/batch — evaluate multiple pairs (max 20)",
          },
          dimensions: {
            contextRelevance: "Did retrieval find relevant chunks? (0-1)",
            faithfulness: "Is the answer supported by context? (0-1)",
            answerRelevance: "Does the answer address the query? (0-1)",
          },
          thresholds: {
            excellent: ">= 0.85 on all dimensions",
            good: ">= 0.70 on all dimensions",
            needsWork: "< 0.70 on any dimension",
          },
          metricsEndpoint: "/metrics → search for rag_triad_score",
        })
      )
    } catch (error: unknown) {
      next(error)
    }
  }
}
