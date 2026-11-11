import { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import multer from "multer"
import { DocumentController } from "../controllers/document.controller"
import { authMiddleware } from "../middleware/auth.middleware"
import { checkDocumentOwnership } from "../middleware/access-control.middleware"
import { createRateLimiter, UPLOAD_LIMIT, LIGHT_LIMIT } from "../middleware/rate-limit.middleware"
import { consumeGlobalBudget } from "../utils/global-budget"

const router = Router()
const controller = new DocumentController()

router.use(authMiddleware)

const uploadRateLimiter = createRateLimiter(UPLOAD_LIMIT)
const lightRateLimiter = createRateLimiter(LIGHT_LIMIT)

// Task 4.1: multipart uploads are buffered in memory, hard-capped at 10 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
})

// Fail fast (before buffering the file) once the global daily LLM budget is
// exhausted. The ingestion queue charges the real embedding cost later.
const globalBudgetGate = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!(await consumeGlobalBudget(1))) {
      res.status(503).json({ success: false, error: "Daily capacity reached, try again tomorrow" })
      return
    }
    next()
  } catch (error: unknown) {
    next(error)
  }
}

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
 * /documents/upload:
 *   post:
 *     summary: Upload a file (multipart) and queue it for ingestion
 *     description: |
 *       Accepts a PDF, TXT, MD or CSV file (max 10 MB) as multipart/form-data
 *       under the `file` field. PDF text is extracted server-side (scanned PDFs
 *       without an extractable text layer are rejected); files must contain
 *       at most 500,000 characters of text. Returns 202 with a jobId —
 *       poll GET /documents/jobs/{jobId} for progress.
 *
 *       **Rate limit**: 20 uploads per day per user.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: PDF, TXT, MD or CSV file (10 MB max)
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
 *       413:
 *         description: File exceeds the 10 MB upload limit
 *       503:
 *         description: Global daily capacity reached
 */
router.post(
  "/upload",
  uploadRateLimiter,
  globalBudgetGate,
  upload.single("file"),
  controller.upload
)

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
