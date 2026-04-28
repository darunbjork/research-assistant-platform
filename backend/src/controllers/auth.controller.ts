// * Handles HTTP concerns only — parse body, call service, send response.

// TODO: PATTERN:
// * 1. Extract data from req.body (already validated by middleware)
// * 2. Call the service method
// * 3. Return ok() response
// * 4. Errors bubble to errorMiddleware automatically

import type { Request, Response, NextFunction } from "express"
import { PrismaClient } from "@prisma/client"
import { AuthService } from "../services/auth.service"
import { ok } from "../types"
import type {
  RegisterRequest,
  LoginRequest,
  RefreshRequest
} from "../types"

const prisma = new PrismaClient()
const authService = new AuthService(prisma)

export class AuthController {

  // * POST /api/v1/auth/register
  register = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const body = req.body as RegisterRequest
      const result = await authService.register(body)
      res.status(201).json(ok(result))
    } catch (error: unknown) {
      next(error)   // ! passes to errorMiddleware
    }
  }

  // * POST /api/v1/auth/login
  login = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const body = req.body as LoginRequest
      const result = await authService.login(body)
      res.status(200).json(ok(result))
    } catch (error: unknown) {
      next(error)
    }
  }

  // * POST /api/v1/auth/refresh
  refresh = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const body = req.body as RefreshRequest

      if (!body.refreshToken || typeof body.refreshToken !== "string") {
        res.status(400).json({ success: false, data: null, error: "refreshToken is required" })
        return
      }

      const result = await authService.refresh(body.refreshToken)
      res.status(200).json(ok(result))
    } catch (error: unknown) {
      next(error)
    }
  }

  // * GET /api/v1/auth/me  (protected — requires authMiddleware)
  me = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      // * req.user is set by authMiddleware — guaranteed to exist here
      // * because authMiddleware runs before this handler
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Not authenticated" })
        return
      }

      const user = await authService.getMe(req.user.userId)
      res.status(200).json(ok(user))
    } catch (error: unknown) {
      next(error)
    }
  }
}