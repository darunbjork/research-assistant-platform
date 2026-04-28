import express, { type Request, type Response } from "express"
import cors from "cors"
import helmet from "helmet"
import dotenv from "dotenv"
import { PrismaClient } from "@prisma/client"
import { ok } from "./types"

// Load .env FIRST — before any process.env access
dotenv.config()

const app = express()
const PORT = process.env.PORT ?? "3001"

// Prisma client — one instance shared across the whole app.
// Creating multiple instances is wasteful (each opens a connection pool).
const prisma = new PrismaClient()

// ── Middleware ────────────────────────────────────────────────────────────
app.use(helmet())
app.use(cors())
app.use(express.json())

// ── Health Check ──────────────────────────────────────────────────────────
// Tests every infrastructure dependency.
// If any service is down, this returns "degraded" — not "ok".
// Your CI/CD and monitoring tools will poll this endpoint.
app.get("/health", async (_req: Request, res: Response) => {
  // Test database: run the simplest possible query
  let dbStatus: "ok" | "error" = "ok"
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    dbStatus = "error"
  }

  // Determine overall status
  // If ANY service is down, the whole system is degraded
  const allOk = dbStatus === "ok"

  res.status(allOk ? 200 : 503).json(ok({
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: {
      api: "ok",
      db: dbStatus
      // redis: "ok" ← Day 3 when we add the Redis client
    }
  }))
})

// ── 404 Handler ───────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, data: null, error: "Route not found" })
})

// ── Start Server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running  → http://localhost:${PORT}`)
  console.log(`🏥 Health check   → http://localhost:${PORT}/health`)
  console.log(`🗄️  Prisma Studio  → npx prisma studio (separate terminal)`)
})

export default app