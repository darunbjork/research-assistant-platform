// Exposes the /metrics endpoint that Prometheus scrapes every 15-30 seconds.
//
// IMPORTANT: In production, protect this endpoint.
// Options: put it on a different port, add IP allowlist, or add basic auth.
// Metrics contain operational data you do not want public.
// In development, it is fine to leave it open.

import { Router, type Request, type Response } from "express"
import { registry } from "../utils/metrics"

const router = Router()

router.get("/metrics", async (_req: Request, res: Response) => {
  try {
    // Content-Type tells Prometheus this is valid Prometheus text format
    res.set("Content-Type", registry.contentType)
    const metrics = await registry.metrics()
    res.send(metrics)
  } catch (error: unknown) {
    res.status(500).send(error instanceof Error ? error.message : "Metrics error")
  }
})

export default router
