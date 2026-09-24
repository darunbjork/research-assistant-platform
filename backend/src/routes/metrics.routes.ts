import { Router, type Request, type Response } from "express"
import { register } from "../utils/metrics"

const router = Router()

router.get("/metrics", async (_req: Request, res: Response) => {
  try {
    res.set("Content-Type", register.contentType)
    res.end(await register.metrics())
  } catch (error: unknown) {
    res.status(500).end(error instanceof Error ? error.message : "Metrics collection failed")
  }
})

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
