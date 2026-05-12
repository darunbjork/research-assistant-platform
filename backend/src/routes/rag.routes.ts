import { Router } from "express"
import { RagController } from "../controllers/rag.controller"
import { authMiddleware } from "../middleware/auth.middleware"
import { createRateLimiter, RAG_LIMIT } from "../middleware/rate-limit.middleware"

const router = Router()
const controller = new RagController()

// Apply auth to all routes
router.use(authMiddleware)

// Create the rate limiter for RAG endpoints
const ragRateLimiter = createRateLimiter(RAG_LIMIT)

/**
 * @swagger
 * /rag/query:
 *   post:
 *     summary: Query the RAG pipeline
 *     description: |
 *       **Rate limit**: 60 requests per hour per user.
 *       Headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 *     tags: [RAG]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *                 example: "What are the revenue risks?"
 *               topK:
 *                 type: integer
 *                 default: 5
 *               minSimilarity:
 *                 type: number
 *                 default: 0.0
 *               documentIds:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: RAG query result with answer and citations
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/query", ragRateLimiter, controller.query)

/**
 * @swagger
 * /rag/query-with-rerank:
 *   post:
 *     summary: Query RAG pipeline with cross-encoder reranking
 *     description: |
 *       Same as /rag/query but adds a cross-encoder reranking pass
 *       after hybrid retrieval. Produces better-ordered context
 *       for the LLM at the cost of one additional Gemini call.
 *
 *       **Rate limit**: 60 requests per hour per user (shared with /query).
 *     tags: [RAG]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *                 example: "What are the revenue risks?"
 *               topK:
 *                 type: integer
 *                 default: 5
 *     responses:
 *       200:
 *         description: Reranked answer with better source ordering
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/query-with-rerank", ragRateLimiter, controller.queryWithRerank)

export default router
