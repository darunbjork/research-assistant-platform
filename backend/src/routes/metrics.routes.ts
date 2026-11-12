// backend/src/routes/metrics.routes.ts
import { Router, type NextFunction, type Request, type Response } from "express"
import { register } from "../utils/metrics"
import { env } from "../config/env"

const router = Router()

// Defence in depth for D19: Caddy won't route /metrics at all (task 5.3),
// but when METRICS_TOKEN is set this guard makes the endpoint anonymous-
// proof on the internal Docker network too. 404 (not 401) so we don't
// advertise that the endpoint exists. Token checked per request so ops can
// rotate it without a restart; the env schema validates min-24-char length
// at startup (task 3.1).
function requireMetricsToken(req: Request, res: Response, next: NextFunction): void {
  const token = env.METRICS_TOKEN
  if (!token) {
    next() // not configured — open (development default)
    return
  }

  if (req.headers.authorization === `Bearer ${token}`) {
    next()
    return
  }

  res.status(404).end()
}

router.get("/metrics", requireMetricsToken, async (_req: Request, res: Response) => {
  try {
    res.set("Content-Type", register.contentType)
    res.end(await register.metrics())
  } catch (error: unknown) {
    res.status(500).end(error instanceof Error ? error.message : "Metrics collection failed")
  }
})

router.get("/metrics/json", requireMetricsToken, async (_req: Request, res: Response) => {
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
