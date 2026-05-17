// backend/src/routes/metrics.routes.ts
// The /metrics endpoint that Prometheus scrapes every 15 seconds.
//
// SECURITY: do NOT add authMiddleware here.
// Prometheus needs to scrape this endpoint without authentication.
// In production: use network-level access control (only allow
// Prometheus's IP to reach this endpoint, block public access).

import { Router, type Request, type Response } from "express"
import { register } from "../utils/metrics"

const router = Router()

// ── GET /metrics ──────────────────────────────────────────────────────────
// Prometheus scrapes this endpoint.
// Returns all metrics in Prometheus text format.
router.get("/metrics", async (_req: Request, res: Response) => {
  try {
    res.set("Content-Type", register.contentType)
    res.end(await register.metrics())
  } catch (error: unknown) {
    res.status(500).end(error instanceof Error ? error.message : "Metrics collection failed")
  }
})

// ── GET /metrics/json ─────────────────────────────────────────────────────
// Human-readable JSON version — for debugging, not for Prometheus.
router.get("/metrics/json", async (_req: Request, res: Response) => {
  try {
    const metrics = await register.getMetricsAsJSON()
    res.json({
      timestamp: new Date().toISOString(),
      metrics,
    })
  } catch (error: unknown) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    })
  }
})

export default router
