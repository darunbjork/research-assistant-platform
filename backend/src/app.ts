/* eslint-disable no-console */
// backend/src/app.ts
// Updated Day 7: Redis health check added

import express, { type Request, type Response } from "express"
import cors from "cors"
import helmet from "helmet"
import dotenv from "dotenv"
import swaggerUi from "swagger-ui-express"
import { PrismaClient } from "@prisma/client"
import { ok } from "./types"
import { logStartup, logError } from "./utils/logger"
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware"
import { errorMiddleware } from "./middleware/error.middleware"
import metricsRouter from "./routes/metrics.routes"
import authRouter from "./routes/auth.routes"
import { swaggerSpec } from "./utils/swagger"
import { checkRedisHealth } from "./utils/redis"

dotenv.config()

const app = express()
const PORT = process.env.PORT ?? "3001"
const prisma = new PrismaClient()

// ── Middleware ────────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: process.env.NODE_ENV === "production" ? undefined : false,
  })
)
app.use(cors())
app.use(express.json())
app.use(requestLoggerMiddleware)

// ── API Documentation ─────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: "Research Assistant API Docs",
      swaggerOptions: { persistAuthorization: true, docExpansion: "none" },
    })
  )
  app.get("/api/docs.json", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json")
    res.json(swaggerSpec)
  })
}

// ── Routes ────────────────────────────────────────────────────────────────
app.use("/", metricsRouter)
app.use("/api/v1/auth", authRouter)

// Health check — now verifies ALL three services
app.get("/health", async (_req: Request, res: Response) => {
  // Run both checks in parallel — faster than sequential
  const [dbStatus, redisStatus] = await Promise.all([
    prisma.$queryRaw`SELECT 1`
      .then((): "ok" => "ok")
      .catch((error: unknown): "error" => {
        logError("Health: database unreachable", error, { service: "HealthCheck" })
        return "error"
      }),
    checkRedisHealth(),
  ])

  const allOk = dbStatus === "ok" && redisStatus === "ok"

  res.status(allOk ? 200 : 503).json(
    ok({
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        api: "ok",
        db: dbStatus,
        redis: redisStatus,
      },
    })
  )
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
    nodeEnv: process.env.NODE_ENV ?? "development",
  })
  console.log(`✅ Server running  → http://localhost:${PORT}`)
  console.log(`🏥 Health check   → http://localhost:${PORT}/health`)
  console.log(`📊 Metrics        → http://localhost:${PORT}/metrics`)
  console.log(`📖 API Docs       → http://localhost:${PORT}/api/docs`)
})

export default app
