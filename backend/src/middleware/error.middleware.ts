// TODO: Global error handler — the safety net for the entire application.
//
// HOW EXPRESS ERROR HANDLING WORKS:
// * A normal middleware has 3 params: (req, res, next)
// * An error middleware has 4 params: (error, req, res, next)
// Express detects the 4-parameter signature and routes errors here automatically.
//
// TODO: WHY THIS MATTERS FOR RAG:
// If EmbeddingService throws "Gemini API rate limit exceeded",
// that error bubbles up through the call stack.
// Without this middleware: Express crashes or returns an HTML error page.
// With this middleware: you get { success: false, error: "Gemini API rate limit exceeded" }
// AND a structured log entry with the full stack trace.

import type { Request, Response, NextFunction } from "express"
import { logError } from "../utils/logger"
import { fail } from "../types"

// ── Custom Error Classes ──────────────────────────────────────────────────
// These let you throw errors with HTTP status codes from anywhere in the app.
// throw new NotFoundError("Document") → 404 { success: false, error: "Document not found" }

export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number = 500,
    public readonly code?: string
  ) {
    super(message)
    this.name = "AppError"
    // Maintain proper stack trace in V8 (Node.js engine)
    Error.captureStackTrace(this, this.constructor)
  }
}

// 404 — resource does not exist
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, "NOT_FOUND")
  }
}

// 400 — request body or params are invalid
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR")
  }
}

// 401 — not authenticated
export class UnauthorizedError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, 401, "UNAUTHORIZED")
  }
}

// 403 — authenticated but not allowed
export class ForbiddenError extends AppError {
  constructor(message: string = "Access denied") {
    super(message, 403, "FORBIDDEN")
  }
}

// 429 — too many requests (rate limiting)
export class RateLimitError extends AppError {
  constructor(message: string = "Too many requests") {
    super(message, 429, "RATE_LIMIT")
  }
}

// ! 500 — something failed in the RAG pipeline specifically
// ! Includes a "step" field so you know WHICH pipeline step failed
export class RAGError extends AppError {
  constructor(
    message: string,
    public readonly step: "chunking" | "embedding" | "retrieval" | "generation" | "agent"
  ) {
    super(`RAG pipeline error at ${step} step: ${message}`, 500, "RAG_ERROR")
  }
}

// ── Error Middleware ──────────────────────────────────────────────────────
// MUST have exactly 4 parameters — Express identifies error handlers by arity.
// The ESLint rule @typescript-eslint/no-unused-vars is suppressed for _next
// because Express requires the parameter even if unused.

export function errorMiddleware(
  error: unknown,
  req: Request,
  res: Response,

  _next: NextFunction
): void {
  // Known application error — we threw this intentionally with a status code
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

  // Prisma database error — connection failed, query failed, constraint violated
  if (isPrismaError(error)) {
    logError("Database error", error, {
      service: "ErrorMiddleware",
      path: req.path,
    })
    res.status(500).json(fail("Database operation failed"))
    return
  }

  // Completely unexpected error — log everything, return generic message
  // Never expose internal error details to the client in production
  logError("Unexpected error", error, {
    service: "ErrorMiddleware",
    path: req.path,
    method: req.method,
  })

  res.status(500).json(
    fail(
      process.env.NODE_ENV === "development"
        ? String(error) // show details in development
        : "Internal server error" // hide details in production
    )
  )
}

// ── Prisma Error Detection ────────────────────────────────────────────────
// Prisma errors have a specific shape. We detect them by their code property.
// Full list: https://www.prisma.io/docs/reference/api-reference/error-reference
function isPrismaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as Record<string, unknown>).code === "string" &&
    String((error as Record<string, unknown>).code).startsWith("P")
  )
}
