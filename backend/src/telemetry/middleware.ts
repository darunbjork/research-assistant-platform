// backend/src/telemetry/middleware.ts
// Express middleware that adds tracing to every HTTP request.
// Enriches the auto-instrumented HTTP span with RAG-specific attributes.

import type { Request, Response, NextFunction } from "express"
import { addSpanAttributes, HTTP_ATTRS } from "./spans"

// ── HTTP Trace Enrichment Middleware ──────────────────────────────────────
// Called on every request. Adds user context to the active span
// created by @opentelemetry/instrumentation-http.
//
// Place AFTER authMiddleware so req.user is populated.

export function traceMiddleware(req: Request, next: NextFunction): void {
  // Add user context if authenticated
  if (req.user) {
    addSpanAttributes({
      [HTTP_ATTRS.USER_ID]: req.user.userId,
      "http.user.role": req.user.role,
      [HTTP_ATTRS.ENDPOINT]: `${req.method} ${req.path}`,
    })
  }

  // Add request size for upload endpoints
  const contentLength = req.headers["content-length"]
  if (contentLength) {
    addSpanAttributes({
      "http.request.content_length": parseInt(contentLength, 10),
    })
  }

  next()
}

// ── Response Time Middleware ──────────────────────────────────────────────
// Tracks response time and adds it to the active span.
export function responseTimeMiddleware(res: Response, next: NextFunction): void {
  const start = Date.now()

  res.on("finish", () => {
    const durationMs = Date.now() - start
    addSpanAttributes({
      "http.response.duration_ms": durationMs,
      "http.response.status_code": res.statusCode,
    })
  })

  next()
}
