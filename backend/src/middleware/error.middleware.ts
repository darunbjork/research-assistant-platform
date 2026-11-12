// TODO: Global error handler — the safety net for the entire application.
import type { Request, Response, NextFunction } from "express"
import multer from "multer"
import { logError } from "../utils/logger"
import { fail } from "../types"
import { env } from "../config/env"
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

  // Task 4.1: multer rejects oversized files while streaming the body.
  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE" ? "File exceeds the 10 MB upload limit" : error.message
    const statusCode = error.code === "LIMIT_FILE_SIZE" ? 413 : 400
    logError("Upload error", error, {
      service: "ErrorMiddleware",
      code: error.code,
      path: req.path,
      method: req.method,
    })
    res.status(statusCode).json(fail(message))
    return
  }

  // F7: body-parser errors from express.json() (oversized or malformed
  // JSON) carry a `type` tag ("entity.too.large", "entity.parse.failed")
  // plus `status`. Without this branch they fell through to the generic
  // 500 below, so a client mistake was reported as "Internal server error"
  // and production logs filled with fake server errors.
  if (isBodyParserError(error)) {
    const statusCode = error.status ?? error.statusCode ?? 400
    logError("Request body error", error, {
      service: "ErrorMiddleware",
      code: error.type,
      path: req.path,
      method: req.method,
    })
    res.status(statusCode).json(fail(bodyParserErrorMessage(error.type)))
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
      env.NODE_ENV === "development"
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

/** Shape that body-parser + http-errors produce in Express 5 (F7). */
interface BodyParserError extends Error {
  type: string
  status?: number
  statusCode?: number
}

function isBodyParserError(error: unknown): error is BodyParserError {
  if (!(error instanceof Error) || !("type" in error)) return false
  if (typeof error.type !== "string") return false
  return "status" in error || "statusCode" in error
}

/** Client-facing messages for body-parser failures (sizes match app.ts limits). */
function bodyParserErrorMessage(type: string): string {
  switch (type) {
    case "entity.too.large":
      return "Request body exceeds the 2 MB limit"
    case "entity.parse.failed":
      return "Invalid JSON in request body"
    case "request.aborted":
      return "Request body was aborted before completion"
    default:
      return "Invalid request body"
  }
}
