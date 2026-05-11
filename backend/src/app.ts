/* eslint-disable no-console */

import express, { type Request, type Response } from "express"
import cors from "cors"
import helmet from "helmet"
import dotenv from "dotenv"
import { createServer } from "http"
import swaggerUi from "swagger-ui-express"
import { PrismaClient } from "@prisma/client"
import { ok } from "./types"
import { logStartup, logError } from "./utils/logger"
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware"
import { errorMiddleware } from "./middleware/error.middleware"
import metricsRouter from "./routes/metrics.routes"
import authRouter from "./routes/auth.routes"
import documentRouter from "./routes/document.routes"
import ragRouter from "./routes/rag.routes"
import agentRouter from "./routes/agent.routes"
import { swaggerSpec } from "./utils/swagger"
import { checkRedisHealth } from "./utils/redis"
import { createWebSocketServer } from "./websocket/ws.server"
import evalRouter from "./routes/eval.routes"

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
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    credentials: true,
  })
)
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
app.use("/api/v1/documents", documentRouter)
app.use("/api/v1/rag", ragRouter)
app.use("/api/v1/agent", agentRouter)
app.use("/api/v1/eval", evalRouter)

// ── Health Check ──────────────────────────────────────────────────────────
app.get("/health", async (_req: Request, res: Response) => {
  const [dbStatus, redisStatus] = await Promise.all([
    prisma.$queryRaw`SELECT 1`
      .then((): "ok" => "ok")
      .catch((error: unknown): "error" => {
        logError("Health: db unreachable", error, { service: "HealthCheck" })
        return "error"
      }),
    checkRedisHealth(),
  ])

  const allOk = dbStatus === "ok" && redisStatus === "ok"

  res.status(allOk ? 200 : 503).json(
    ok({
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      services: { api: "ok", db: dbStatus, redis: redisStatus },
    })
  )
})

// ── 404 Handler ───────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, data: null, error: "Route not found" })
})

// ── Error Middleware — MUST BE LAST ───────────────────────────────────────
app.use(errorMiddleware)

// ── Start HTTP + WebSocket Server ─────────────────────────────────────────
// createServer() wraps Express in a Node.js HTTP server.
// This lets us attach the WebSocket server to the same port.
const httpServer = createServer(app)
createWebSocketServer(httpServer) // attach WebSocket to same HTTP server

httpServer.listen(PORT, () => {
  logStartup("Server started", {
    service: "App",
    port: Number(PORT),
    nodeEnv: process.env.NODE_ENV ?? "development",
  })
  console.log(`✅ HTTP  server → http://localhost:${PORT}`)
  console.log(`🔌 WebSocket   → ws://localhost:${PORT}/ws/agent`)
  console.log(`🏥 Health      → http://localhost:${PORT}/health`)
  console.log(`📊 Metrics     → http://localhost:${PORT}/metrics`)
  console.log(`📖 API Docs    → http://localhost:${PORT}/api/docs`)
})

export default app
