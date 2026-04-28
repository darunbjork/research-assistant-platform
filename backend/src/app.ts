import express, { type Request, type Response, type NextFunction } from "express"
import cors from "cors"
import helmet from "helmet"
import dotenv from "dotenv"
import { ok } from "./types"

// Load .env file FIRST — before any process.env access
dotenv.config()

const app = express()
const PORT = process.env.PORT ?? "3001"

// ── Middleware ────────────────────────────────────────────────────────────
// These run on EVERY request, in order.

app.use(helmet())         // secure headers: prevents clickjacking, XSS, etc.
app.use(cors())           // allows cross-origin requests from your React dev server
app.use(express.json())   // parses JSON request body into req.body

// ── Health Check ─────────────────────────────────────────────────────────
// The very first thing you test after any deploy.
// Returns the status of every connected service.
// We will add db and redis here on Day 2.
app.get("/health", (_req: Request, res: Response) => {
  res.json(ok({
    status: "ok",
    timestamp: new Date().toISOString(),
    services: {
      api: "ok"
    }
  }))
})

// ── 404 Handler ───────────────────────────────────────────────────────────
// Any route not matched above falls through to here.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, data: null, error: "Route not found" })
})

// ── Start Server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running → http://localhost:${PORT}`)
  console.log(`🏥 Health check  → http://localhost:${PORT}/health`)
})

export default app