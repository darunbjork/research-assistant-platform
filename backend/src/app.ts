/* eslint-disable no-console */
import "./preload-env"
import { env } from "./config/env"
import "./telemetry/tracer"
import express, { type Request, type Response } from "express"
import cors from "cors"
import helmet from "helmet"
import dotenv from "dotenv"
import { createServer } from "http"
import swaggerUi from "swagger-ui-express"
import { prisma } from "./utils/prisma"
import { ok, fail } from "./types"
import { logStartup, logError } from "./utils/logger"
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware"
import { errorMiddleware } from "./middleware/error.middleware"
import metricsRouter from "./routes/metrics.routes"
import authRouter from "./routes/auth.routes"
import documentRouter from "./routes/document.routes"
import ragRouter from "./routes/rag.routes"
import agentRouter from "./routes/agent.routes"
import { swaggerSpec } from "./utils/swagger"
import { checkRedisHealth, redis } from "./utils/redis"
import { createWebSocketServer, closeAllWsClients } from "./websocket/ws.server"
import { abortRunningAgents } from "./websocket/agent.ws.handler"
import { createShutdown, registerShutdown, isShuttingDown } from "./lifecycle/shutdown"
import { getIngestionQueue } from "./queue/index"
import { shutdownTracing } from "./telemetry/tracer"
import evalRouter from "./routes/eval.routes"
import rateLimitRouter from "./routes/rate-limit.routes"

dotenv.config()

const app = express()
const PORT = env.PORT

// Caddy is the single reverse proxy in front (task 5.3), so trust exactly
// one hop: req.ip then reflects the real client address instead of the
// proxy's — required for the IP-based auth rate limits (D20).
app.set("trust proxy", 1)

// ── Middleware ────────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: env.NODE_ENV === "production" ? undefined : false,
  })
)
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  })
)
// 2 MB covers 500,000 characters of multibyte text plus the JSON envelope
// (D9) while still bounding memory per request.
app.use(express.json({ limit: "2mb" }))
app.use(requestLoggerMiddleware)

// ── API Documentation ─────────────────────────────────────────────────────
if (env.NODE_ENV !== "production") {
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
app.use("/api/v1/rate-limits", rateLimitRouter)

// ── Health Check ──────────────────────────────────────────────────────────
app.get("/health", async (_req: Request, res: Response) => {
  // Task 5.5: during shutdown serve 503 so the proxy drains traffic.
  if (isShuttingDown()) {
    res.status(503).json(fail("Shutting down"))
    return
  }

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

// ── Graceful shutdown (task 5.5 / D13) ────────────────────────────────────
const shutdown = createShutdown({
  httpServer,
  abortRunningAgents,
  closeAllWsClients,
  closeQueue: async (): Promise<void> => {
    await getIngestionQueue().close()
  },
  disconnectDatabase: async (): Promise<void> => {
    await prisma.$disconnect()
  },
  quitRedis: async (): Promise<void> => {
    await redis.quit()
  },
  shutdownTracing,
})
registerShutdown(shutdown)

httpServer.listen(PORT, () => {
  logStartup("Server started", {
    service: "App",
    port: PORT,
    nodeEnv: env.NODE_ENV,
  })
  console.log(`✅ HTTP  server → http://localhost:${PORT}`)
  console.log(`🔌 WebSocket   → ws://localhost:${PORT}/ws/agent`)
  console.log(`🏥 Health      → http://localhost:${PORT}/health`)
  console.log(`📊 Metrics     → http://localhost:${PORT}/metrics`)
  console.log(`📖 API Docs    → http://localhost:${PORT}/api/docs`)
})

export default app
