import { Router } from "express"
import { DocumentController } from "../controllers/document.controller"
import { authMiddleware } from "../middleware/auth.middleware"

const router = Router()
const controller = new DocumentController()

router.use(authMiddleware)

/**
 * @swagger
 * /documents/ingest:
 *   post:
 *     summary: Ingest a document (async — returns immediately)
 *     description: |
 *       Queues a document for background ingestion via Bull Queue.
 *       Returns 202 Accepted immediately with a jobId.
 *       Poll GET /documents/jobs/{jobId} to track progress.
 *
 *       Pipeline (runs in background):
 *       1. Chunk text with recursive strategy
 *       2. Embed all chunks with Gemini text-embedding-004
 *       3. Store chunks + vectors in pgvector
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
 *               name:     { type: string, example: "Q3-Report.txt" }
 *               content:  { type: string }
 *               mimeType: { type: string, example: "text/plain" }
 *     responses:
 *       202:
 *         description: Document queued for background ingestion
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:   { type: string }
 *                 status:  { type: string, example: "queued" }
 *                 message: { type: string }
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/ingest", controller.ingest)

/**
 * @swagger
 * /documents/jobs/{jobId}:
 *   get:
 *     summary: Get ingestion job status and progress
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: jobId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job status with progress percentage
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:      { type: string }
 *                 status:     { type: string, enum: [waiting, active, completed, failed] }
 *                 progress:   { type: number, minimum: 0, maximum: 100 }
 *                 result:     { type: object, description: "Present when status is completed" }
 *                 error:      { type: string, description: "Present when status is failed" }
 *       404:
 *         description: Job not found (expired or invalid ID)
 */
router.get("/jobs/:jobId", controller.getJobStatus)

/**
 * @swagger
 * /documents/cache/stats:
 *   get:
 *     summary: Get search cache performance statistics
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cache hit rate and statistics
 */
router.get("/cache/stats", controller.cacheStats)

router.get("/", controller.list)
router.get("/:id", controller.getById)
router.delete("/:id", controller.delete)

export default router
