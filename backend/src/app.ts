// backend/src/app.ts
// Root of the Express application — updated Day 3.
// Now includes: structured logging, Prometheus metrics, error middleware,
// request logging, and a /metrics endpoint.

import express, { type Request, type Response } from "express"
import cors from "cors"
import helmet from "helmet"
import dotenv from "dotenv"
import { PrismaClient } from "@prisma/client"
import { ok } from "./types"
import { logStartup, logError } from "./utils/logger"
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware"
import { errorMiddleware } from "./middleware/error.middleware"
import metricsRouter from "./routes/metrics.routes"

// Load .env FIRST — before any process.env access
dotenv.config()

const app = express()
const PORT = process.env.PORT ?? "3001"

// One shared Prisma instance — never create inside a request handler
const prisma = new PrismaClient()

// ── Middleware Stack ───────────────────────────────────────────────────────
// Order matters. Each middleware runs in sequence for every request.

app.use(helmet())                    // 1. Security headers first
app.use(cors())                      // 2. CORS — allow frontend origin
app.use(express.json())              // 3. Parse JSON bodies
app.use(requestLoggerMiddleware)     // 4. Log every request + record metrics

// ── Routes ────────────────────────────────────────────────────────────────

// Metrics endpoint — Prometheus scrapes this
app.use("/", metricsRouter)

// Health check — verifies all infrastructure is alive
app.get("/health", async (_req: Request, res: Response) => {
  let dbStatus: "ok" | "error" = "ok"

  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (error: unknown) {
    dbStatus = "error"
    logError("Health check: database unreachable", error, {
      service: "HealthCheck"
    })
  }

  const allOk = dbStatus === "ok"

  res.status(allOk ? 200 : 503).json(ok({
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: {
      api: "ok",
      db: dbStatus
      // redis: "ok" ← Day 3 extension below
    }
  }))
})

// ── 404 Handler ───────────────────────────────────────────────────────────
// Must come AFTER all real routes.
// Any request that did not match above falls through to here.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, data: null, error: "Route not found" })
})

// ── Error Middleware ───────────────────────────────────────────────────────
// MUST be registered LAST — after all routes.
// Any error passed to next(error) anywhere in the app lands here.
app.use(errorMiddleware)

// ── Start Server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logStartup("Server started", {
    service: "App",
    port: Number(PORT),
    nodeEnv: process.env.NODE_ENV ?? "development"
  })
  console.log(`✅ Server running  → http://localhost:${PORT}`)
  console.log(`🏥 Health check   → http://localhost:${PORT}/health`)
  console.log(`📊 Metrics        → http://localhost:${PORT}/metrics`)
  console.log(`🗄️  Prisma Studio  → run: npx prisma studio`)
})

export default app