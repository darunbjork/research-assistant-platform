import type { Request, Response, NextFunction } from "express"
import { PrismaClient } from "@prisma/client"
import { NotFoundError } from "./error.middleware"

const prisma = new PrismaClient()

// ── checkDocumentOwnership ─────────────────────────────────────────────────
// Middleware that verifies the authenticated user owns the document
// referenced in req.params.id or req.params.documentId.
//
// Usage:
//   router.get("/:id", authMiddleware, checkDocumentOwnership, controller.getById)
//   router.delete("/:id", authMiddleware, checkDocumentOwnership, controller.delete)

export async function checkDocumentOwnership(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    // authMiddleware should run first — if we reach here without a user, skip
    next()
    return
  }

  const documentId = (req.params["id"] ?? req.params["documentId"]) as string | undefined

  if (!documentId) {
    // No document ID in params — not applicable (e.g. list endpoint)
    next()
    return
  }

  try {
    const document = await prisma.document.findFirst({
      where: {
        id: documentId,
        userId: req.user.userId,
      },
      select: { id: true }, // only need to confirm existence + ownership
    })

    if (document === null) {
      // Return 404 — not 403 — to avoid revealing document existence
      throw new NotFoundError("Document")
    }

    // Ownership confirmed — proceed to the route handler
    next()
  } catch (error: unknown) {
    next(error)
  }
}

// ── checkChunkBelongsToUser ────────────────────────────────────────────────
// Verifies that a chunk belongs to a document owned by the authenticated user.
// Used on chunk-level endpoints (if added in the future).

export async function checkChunkBelongsToUser(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    next()
    return
  }

  const chunkId = req.params["chunkId"] as string | undefined
  if (!chunkId) {
    next()
    return
  }

  try {
    const chunk = await prisma.documentChunk.findFirst({
      where: {
        id: chunkId,
        document: { userId: req.user.userId },
      },
      select: { id: true },
    })

    if (chunk === null) {
      throw new NotFoundError("Chunk")
    }

    next()
  } catch (error: unknown) {
    next(error)
  }
}

// ── requireOwnerOrAdmin ────────────────────────────────────────────────────
// Middleware that allows ADMIN users to access any document,
// while USER-role users can only access their own.
// Useful for admin dashboard endpoints.

export async function requireOwnerOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    next()
    return
  }

  // ADMIN users bypass ownership checks
  if (req.user.role === "ADMIN") {
    next()
    return
  }

  // For non-admin users, enforce ownership
  return checkDocumentOwnership(req, res, next)
}
