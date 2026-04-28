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
import authRouter from "./routes/auth.routes"

dotenv.config()

const app = express()
const PORT = process.env.PORT ?? "3001"
const prisma = new PrismaClient()

// ── Middleware ────────────────────────────────────────────────────────────
app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(requestLoggerMiddleware)

// ── Routes ────────────────────────────────────────────────────────────────
app.use("/", metricsRouter)

// Auth routes — /api/v1/auth/register, /login, /refresh, /me
app.use("/api/v1/auth", authRouter)

// Health check
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
    }
  }))
})

// ── 404 Handler ───────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, data: null, error: "Route not found" })
})

// ── Error Middleware — MUST BE LAST ───────────────────────────────────────
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
  console.log(`🔐 Auth           → http://localhost:${PORT}/api/v1/auth`)
})

export default app