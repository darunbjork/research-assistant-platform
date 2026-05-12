import { Router, type Request, type Response, type NextFunction } from "express"
import { authMiddleware } from "../middleware/auth.middleware"
import { getRateLimitStatus } from "../middleware/rate-limit.middleware"
import {
  RAG_LIMIT,
  AGENT_LIMIT,
  UPLOAD_LIMIT,
  EVAL_LIMIT,
  LIGHT_LIMIT,
} from "../middleware/rate-limit.middleware"
import { ok } from "../types"

const router = Router()
router.use(authMiddleware)

/**
 * @swagger
 * /rate-limits/status:
 *   get:
 *     summary: Get current rate limit status for the authenticated user
 *     description: |
 *       Shows how many requests the user has made and how many remain
 *       for each endpoint category.
 *     tags: [Rate Limits]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Rate limit status per endpoint
 */
router.get("/status", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, data: null, error: "Not authenticated" })
      return
    }

    const statuses = await getRateLimitStatus(req.user.userId, [
      RAG_LIMIT,
      AGENT_LIMIT,
      UPLOAD_LIMIT,
      EVAL_LIMIT,
      LIGHT_LIMIT,
    ])

    res.status(200).json(
      ok({
        userId: req.user.userId,
        statuses,
        message: "Limits reset at the end of each window (1 hour for most, 24 hours for uploads)",
      })
    )
  } catch (error: unknown) {
    next(error)
  }
})

/**
 * @swagger
 * /rate-limits/reset/{endpoint}:
 *   delete:
 *     summary: Reset rate limit for a specific endpoint (ADMIN only)
 *     description: Allows admins to clear a user's rate limit counter.
 *     tags: [Rate Limits]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: endpoint
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           enum: [rag, agent, upload, eval, light]
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 */
router.delete(
  "/reset/:endpoint",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user || req.user.role !== "ADMIN") {
        res.status(403).json({ success: false, data: null, error: "Admin access required" })
        return
      }

      const { endpoint } = req.params
      const { userId } = req.query as { userId?: string }

      if (!userId) {
        res
          .status(400)
          .json({ success: false, data: null, error: "userId query parameter required" })
        return
      }

      const { redis } = await import("../utils/redis")
      const key = `rl:${endpoint ?? "unknown"}:${userId}`
      const deleted = await redis.del(key)

      res.status(200).json(
        ok({
          deleted: deleted > 0,
          key,
          message:
            deleted > 0
              ? `Rate limit counter for ${endpoint} reset for user ${userId}`
              : `No active rate limit found for ${endpoint}/${userId}`,
        })
      )
    } catch (error: unknown) {
      next(error)
    }
  }
)

export default router
