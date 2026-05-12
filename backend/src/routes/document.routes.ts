import { Router } from "express"
import { DocumentController } from "../controllers/document.controller"
import { authMiddleware } from "../middleware/auth.middleware"
import { checkDocumentOwnership } from "../middleware/access-control.middleware"
import { createRateLimiter, UPLOAD_LIMIT, LIGHT_LIMIT } from "../middleware/rate-limit.middleware"

const router = Router()
const controller = new DocumentController()

router.use(authMiddleware)

const uploadRateLimiter = createRateLimiter(UPLOAD_LIMIT)
const lightRateLimiter = createRateLimiter(LIGHT_LIMIT)

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
 *       **Rate limit**: 20 uploads per day per user.
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
router.post("/ingest", uploadRateLimiter, controller.ingest)

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
router.get("/jobs/:jobId", lightRateLimiter, controller.getJobStatus)

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
router.get("/cache/stats", lightRateLimiter, controller.cacheStats)

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
 *         schema: { type: integer, default: 20 }
 *       - name: offset
 *         in: query
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated document list
 */
router.get("/", lightRateLimiter, controller.list)

/**
 * @swagger
 * /documents/{id}:
 *   get:
 *     summary: Get document details and chunk previews
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
 *         description: Document with chunk list
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/:id", lightRateLimiter, checkDocumentOwnership, controller.getById)

/**
 * @swagger
 * /documents/{id}:
 *   delete:
 *     summary: Delete a document and its chunks
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
 *         description: Document deleted (no content)
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete("/:id", lightRateLimiter, checkDocumentOwnership, controller.delete)

export default router
