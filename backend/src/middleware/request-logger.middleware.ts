import type { Request, Response, NextFunction } from "express"
import { logRequest } from "../utils/logger"
import { httpRequestDuration, httpRequestsTotal } from "../utils/metrics"

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now()

  res.on("finish", () => {
    const durationMs = Date.now() - startTime
    const status = res.statusCode

    const normalisedPath = req.path
      .replace(/\/[0-9a-f]{24,}/gi, "/:id")
      .replace(/\/c[a-z0-9]{20,}/gi, "/:id")

    logRequest(req.method, normalisedPath, status, durationMs, {
      userId: req.user?.userId,
    })

    httpRequestDuration.labels(req.method, normalisedPath, String(status)).observe(durationMs)

    httpRequestsTotal.labels(req.method, normalisedPath, String(status)).inc()
  })

  next()
}
