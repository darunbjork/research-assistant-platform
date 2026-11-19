// backend/src/routes/livez.routes.ts
//
// GET /livez — liveness only: "is this process able to answer HTTP?".
//
// WHY separate from /health: /health checks Postgres and Redis and returns
// 503 while shutting down, which is right for READINESS (stop routing
// traffic here). Used for LIVENESS it would make Kubernetes restart a healthy
// process during a database blip, or kill it mid-drain, dropping every
// WebSocket session. /livez touches no dependency and stays 200 during the
// graceful shutdown.
//
// Not routed by the Ingress (only /api, /ws, /health and / are); the kubelet
// probes the pod directly.
import { Router, type Request, type Response } from "express"

const router = Router()

router.get("/livez", (_req: Request, res: Response): void => {
  res.set("Cache-Control", "no-store")
  res.json({ status: "ok" })
})

export default router
