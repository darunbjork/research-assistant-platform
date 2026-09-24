import type { Request, Response, NextFunction } from "express"
import { PrismaClient } from "@prisma/client"
import { NotFoundError } from "./error.middleware"

const prisma = new PrismaClient()

export async function checkDocumentOwnership(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    next()
    return
  }

  const documentId = (req.params["id"] ?? req.params["documentId"]) as string | undefined

  if (!documentId) {
    next()
    return
  }

  try {
    const document = await prisma.document.findFirst({
      where: {
        id: documentId,
        userId: req.user.userId,
      },
      select: { id: true },
    })

    if (document === null) {
      throw new NotFoundError("Document")
    }
    next()
  } catch (error: unknown) {
    next(error)
  }
}

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

export async function requireOwnerOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    next()
    return
  }

  if (req.user.role === "ADMIN") {
    next()
    return
  }

  return checkDocumentOwnership(req, res, next)
}
