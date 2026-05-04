// backend/src/routes/rag.routes.ts

import { Router } from "express"
import { RagController } from "../controllers/rag.controller"
import { authMiddleware } from "../middleware/auth.middleware"

const router = Router()
const controller = new RagController()

router.use(authMiddleware)

/**
 * @swagger
 * /rag/query:
 *   post:
 *     summary: Query the RAG pipeline — ask a question about your documents
 *     description: |
 *       Runs the complete RAG pipeline:
 *       1. Embeds the query with Gemini text-embedding-004
 *       2. Runs hybrid search (vector + BM25 keyword) across your documents
 *       3. Merges results with Reciprocal Rank Fusion
 *       4. Builds a grounded prompt with the top-K chunks
 *       5. Calls Gemini gemini-2.0-flash with temperature=0.1
 *       6. Returns the answer with source citations
 *
 *       The system prompt instructs Gemini to ONLY use the retrieved context.
 *       If no relevant chunks are found, returns a "I don't have information"
 *       response instead of hallucinating.
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
 *                 description: The question to ask about your documents
 *                 example: "What does the document say about machine learning?"
 *               topK:
 *                 type: integer
 *                 description: How many chunks to retrieve (default 10)
 *                 example: 5
 *               minSimilarity:
 *                 type: number
 *                 description: Minimum cosine similarity threshold 0-1 (default 0.0)
 *                 example: 0.5
 *               documentIds:
 *                 type: array
 *                 items: { type: string }
 *                 description: Optional — restrict search to these document IDs
 *     responses:
 *       200:
 *         description: Grounded answer with source citations
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResult'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         answer:
 *                           type: string
 *                           example: "Machine learning is a subset of AI [Source 1]."
 *                         citations:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/Citation'
 *                         chunksRetrieved: { type: integer, example: 3 }
 *                         chunksUsed:      { type: integer, example: 3 }
 *                         tokensUsed:      { type: integer, example: 847 }
 *                         model:           { type: string, example: "gemini-2.0-flash" }
 *                         durationMs:      { type: integer, example: 1823 }
 *                         retrievalMs:     { type: integer, example: 45 }
 *                         generationMs:    { type: integer, example: 1778 }
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
router.post("/query", controller.query)

export default router
