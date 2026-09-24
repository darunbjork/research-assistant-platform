import type { Request, Response, NextFunction } from "express"
import { verifyAccessToken } from "../utils/jwt.utils"
import type { JwtPayload } from "../types"
import { PrismaClient } from "@prisma/client"
import { UnauthorizedError } from "./error.middleware"

const prisma = new PrismaClient()

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload
    }
  }
}

export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith("Bearer ")) {
    next(new UnauthorizedError("No token provided"))
    return
  }

  const token = authHeader.slice(7)

  try {
    const payload = verifyAccessToken(token)

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true },
    })

    if (user === null) {
      next(new UnauthorizedError("User account no longer exists. Please register or log in again."))
      return
    }

    req.user = payload
    next()
  } catch (error: unknown) {
    next(error)
  }
}

export function requireRole(...roles: Array<"GUEST" | "USER" | "ADMIN">) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new Error("Authentication required"))
      return
    }

    if (!roles.includes(req.user.role)) {
      next(new Error("Insufficient permissions"))
      return
    }

    next()
  }
}
