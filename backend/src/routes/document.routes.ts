// backend/src/routes/document.routes.ts

import { Router } from "express"
import { DocumentController } from "../controllers/document.controller"
import { authMiddleware } from "../middleware/auth.middleware"

const router = Router()
const controller = new DocumentController()

// All document routes require authentication —
// authMiddleware is applied to the whole router
router.use(authMiddleware)

/**
 * @swagger
 * /documents/ingest:
 *   post:
 *     summary: Ingest a document into the RAG pipeline
 *     description: |
 *       Runs the full ingestion pipeline:
 *       1. Validates the document
 *       2. Creates a Document record in PostgreSQL
 *       3. Chunks the text using recursive strategy
 *       4. Embeds all chunks via Gemini text-embedding-004
 *       5. Stores chunks + vectors in pgvector
 *
 *       After ingestion, the document is immediately searchable.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, content, mimeType]
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Q3-Report.txt"
 *               content:
 *                 type: string
 *                 description: The full text content of the document
 *                 example: "Q3 revenue was $4.2 million, representing a 23% increase..."
 *               mimeType:
 *                 type: string
 *                 example: "text/plain"
 *     responses:
 *       202:
 *         description: Document ingested successfully
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
 *                         documentId:  { type: string }
 *                         name:        { type: string }
 *                         chunkCount:  { type: integer, example: 12 }
 *                         tokenCount:  { type: integer, example: 1847 }
 *                         strategy:    { type: string, example: "recursive" }
 *                         durationMs:  { type: integer, example: 1823 }
 *                         warnings:    { type: array, items: { type: string } }
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/ingest", controller.ingest)

/**
 * @swagger
 * /documents:
 *   get:
 *     summary: List all documents for the authenticated user
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - name: offset
 *         in: query
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated list of documents with chunk counts
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/", controller.list)

/**
 * @swagger
 * /documents/{id}:
 *   get:
 *     summary: Get a document and its chunks
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Document with chunk previews (no vectors)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/:id", controller.getById)

/**
 * @swagger
 * /documents/{id}:
 *   delete:
 *     summary: Delete a document and all its chunks
 *     description: Permanently removes the document and all pgvector embeddings.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Document deleted successfully
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete("/:id", controller.delete)

export default router
