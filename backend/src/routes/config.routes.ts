// backend/src/routes/config.routes.ts
//
// GET /api/v1/config — public, read-only server capabilities:
//   { success: true, data: { voice: { stt, tts } }, error: null }
// No auth: the UI needs it before login, and it holds two booleans only
// (see config/capabilities.ts). No secrets, key presence or provider names.
import { Router, type Request, type Response } from "express"
import { env } from "../config/env"
import { serverCapabilities } from "../config/capabilities"
import { ok } from "../types"

const router = Router()

router.get("/", (_req: Request, res: Response): void => {
  // Config only changes with a redeploy, which restarts the pod; a short
  // cache spares repeat page loads without outliving a rollout for long.
  res.set("Cache-Control", "public, max-age=60")
  res.json(ok(serverCapabilities(env)))
})

export default router
