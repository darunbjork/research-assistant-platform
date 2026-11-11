// backend/src/controllers/agent.controller.ts
// HTTP layer for the agent. Parses the request, runs the agent,
// returns the result. No business logic here.

import type { Request, Response, NextFunction } from "express"
import { prisma } from "../utils/prisma"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { GenerationService } from "../services/generation.service"
import { AgentService } from "../services/agent.service"
import { ValidationError } from "../middleware/error.middleware"
import { ok } from "../types"
import { consumeGlobalBudget } from "../utils/global-budget"
import { MAX_QUERY_LENGTH } from "../middleware/validate.middleware"
import { isAbortError } from "../utils/abort"
import redis from "../utils/redis"

// ── Service Initialisation ────────────────────────────────────────────────
const embeddingService = new EmbeddingService(process.env.GEMINI_API_KEY ?? "", redis)
const hybridSearchService = new HybridSearchService(prisma, embeddingService)
const generationService = new GenerationService(process.env.GEMINI_API_KEY ?? "")
const agentService = new AgentService(
  process.env.GEMINI_API_KEY ?? "",
  hybridSearchService,
  generationService
)

export class AgentController {
  // ── POST /api/v1/agent/chat ───────────────────────────────────────────
  chat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const { query } = req.body as { query?: string }

      if (!query || typeof query !== "string" || query.trim() === "") {
        throw new ValidationError("Request body must include 'query' (non-empty string)")
      }

      if (query.length > MAX_QUERY_LENGTH) {
        throw new ValidationError(`'query' must be at most ${MAX_QUERY_LENGTH} characters`)
      }

      // Global daily budget: an agent run costs 5 units.
      if (!(await consumeGlobalBudget(5))) {
        res
          .status(503)
          .json({ success: false, error: "Daily capacity reached, try again tomorrow" })
        return
      }

      // Abort the run when the client disconnects before the response is
      // finished. `res` "close" with `writableEnded === false` is the reliable
      // disconnect signal on Node >= 16 — `req` "close" fires as soon as the
      // request body has been read (verified empirically; see FOUND_DURING_FIX).
      const controller = new AbortController()
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort()
      }
      res.on("close", onClose)

      let result: Awaited<ReturnType<typeof agentService.run>>
      try {
        result = await agentService.run(query.trim(), req.user.userId, controller.signal)
      } finally {
        res.off("close", onClose)
      }

      // Client is gone — nothing left to respond to.
      if (controller.signal.aborted) return

      res.status(200).json(ok(result))
    } catch (error: unknown) {
      // A cancellation is not a server error — do not forward to the error
      // middleware (the connection is already closed).
      if (isAbortError(error)) {
        return
      }
      next(error)
    }
  }
}
