// * Protects routes that require authentication.
// * Usage: router.post("/documents", authMiddleware, controller.upload)
//
// TODO HOW IT WORKS:
// ? 1. Reads the Authorization header: "Bearer eyJhbGciOiJIUzI1NiJ9..."
// ? 2. Extracts the token (everything after "Bearer ")
// ? 3. Verifies the signature and expiry with verifyAccessToken()
// ? 4. Attaches the decoded payload to req.user
// ? 5. Calls next() → the route handler runs
//
// ! If anything fails → throws UnauthorizedError → errorMiddleware returns 401

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

export async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith("Bearer ")) {
    next(new UnauthorizedError("No token provided"))
    return
  }

  const token = authHeader.slice(7)

  try {
    const payload = verifyAccessToken(token)

    // Verify the user exists in the database to prevent database state desync
    // (e.g. after a database reset/wipe where the JWT is still structurally valid)
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

// Optional middleware: requires a specific role
// Usage: router.delete("/users/:id", authMiddleware, requireRole("ADMIN"), controller.delete)
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
