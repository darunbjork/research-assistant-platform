// backend/src/routes/rag.routes.ts

import { Router } from "express"
import { RagController } from "../controllers/rag.controller"
import { authMiddleware } from "../middleware/auth.middleware"

const router = Router()
const controller = new RagController()

router.use(authMiddleware)

/**
 * @swagger
 * /rag/query-with-rerank:
 *   post:
 *     summary: Query RAG pipeline with cross-encoder reranking
 *     description: |
 *       Same as /rag/query but adds a cross-encoder reranking pass
 *       after hybrid retrieval. Produces better-ordered context
 *       for the LLM at the cost of one additional Gemini call.
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
router.post("/query-with-rerank", controller.queryWithRerank)

export default router
