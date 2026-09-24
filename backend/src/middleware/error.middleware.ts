// TODO: Global error handler — the safety net for the entire application.
import type { Request, Response, NextFunction } from "express"
import { logError } from "../utils/logger"
import { fail } from "../types"
export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number = 500,
    public readonly code?: string
  ) {
    super(message)
    this.name = "AppError"
    Error.captureStackTrace(this, this.constructor)
  }
}
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, "NOT_FOUND")
  }
}
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR")
  }
}
export class UnauthorizedError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, 401, "UNAUTHORIZED")
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Access denied") {
    super(message, 403, "FORBIDDEN")
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = "Too many requests") {
    super(message, 429, "RATE_LIMIT")
  }
}
export class RAGError extends AppError {
  constructor(
    message: string,
    public readonly step: "chunking" | "embedding" | "retrieval" | "generation" | "agent"
  ) {
    super(`RAG pipeline error at ${step} step: ${message}`, 500, "RAG_ERROR")
  }
}

export function errorMiddleware(
  error: unknown,
  req: Request,
  res: Response,

  _next: NextFunction
): void {
  if (error instanceof AppError) {
    logError("Application error", error, {
      service: "ErrorMiddleware",
      code: error.code,
      path: req.path,
      method: req.method,
    })
    res.status(error.statusCode).json(fail(error.message))
    return
  }

  if (isPrismaError(error)) {
    logError("Database error", error, {
      service: "ErrorMiddleware",
      path: req.path,
    })
    res.status(500).json(fail("Database operation failed"))
    return
  }

  logError("Unexpected error", error, {
    service: "ErrorMiddleware",
    path: req.path,
    method: req.method,
  })

  res.status(500).json(
    fail(
      process.env.NODE_ENV === "development"
        ? String(error) // show details in development
        : "Internal server error"
    )
  )
}

function isPrismaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as Record<string, unknown>).code === "string" &&
    String((error as Record<string, unknown>).code).startsWith("P")
  )
}
