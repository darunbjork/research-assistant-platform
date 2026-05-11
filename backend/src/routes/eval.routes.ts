// backend/src/routes/eval.routes.ts

import { Router } from "express"
import { EvalController } from "../controllers/eval.controller"
import { authMiddleware } from "../middleware/auth.middleware"

const router = Router()
const controller = new EvalController()

router.use(authMiddleware)

/**
 * @swagger
 * /eval/score:
 *   post:
 *     summary: Evaluate a query-answer pair using the RAG Triad
 *     description: |
 *       Scores one RAG pipeline output on three dimensions:
 *
 *       **Context Relevance**: Did the retrieval find relevant chunks?
 *       **Faithfulness**: Is the answer grounded in the retrieved context?
 *       **Answer Relevance**: Does the answer address the query?
 *
 *       Uses Gemini as an LLM judge to score each dimension separately.
 *       Scores are recorded in Prometheus at /metrics.
 *     tags: [Evaluation]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query, retrievedContext, answer]
 *             properties:
 *               query:
 *                 type: string
 *                 example: "What are the main risks in Q3?"
 *               retrievedContext:
 *                 type: array
 *                 items: { type: string }
 *                 description: The chunk contents retrieved by the RAG pipeline
 *               answer:
 *                 type: string
 *                 description: The generated answer to evaluate
 *               pipelineVersion:
 *                 type: string
 *                 example: "v2-with-reranker"
 *                 description: Optional label for A/B testing
 *     responses:
 *       200:
 *         description: RAG Triad scores with explanations and recommendations
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/score", controller.score)

/**
 * @swagger
 * /eval/batch:
 *   post:
 *     summary: Evaluate multiple query-answer pairs
 *     description: |
 *       Evaluates a batch of query-answer pairs and returns aggregate scores.
 *       Use this for systematic pipeline quality measurement.
 *       Maximum 20 pairs per request (API rate limit protection).
 *     tags: [Evaluation]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pairs]
 *             properties:
 *               pairs:
 *                 type: array
 *                 maxItems: 20
 *                 items:
 *                   type: object
 *                   properties:
 *                     query:            { type: string }
 *                     retrievedContext: { type: array, items: { type: string } }
 *                     answer:           { type: string }
 *               pipelineVersion:
 *                 type: string
 *     responses:
 *       200:
 *         description: Batch evaluation results with aggregate scores
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/batch", controller.batch)

/**
 * @swagger
 * /eval/summary:
 *   get:
 *     summary: Get evaluation endpoint documentation and thresholds
 *     tags: [Evaluation]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Summary of evaluation capabilities and thresholds
 */
router.get("/summary", controller.summary)

export default router
