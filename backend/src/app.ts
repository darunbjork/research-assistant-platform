/* eslint-disable no-console */
// TODO: Swagger UI mounted at /api/docs

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

dotenv.config()

const app = express()
const PORT = process.env.PORT ?? "3001"
const prisma = new PrismaClient()

// ── Middleware ────────────────────────────────────────────────────────────
app.use(
  helmet({
    // Swagger UI loads external CSS and JS — helmet blocks this by default
    // This relaxes Content-Security-Policy only for the docs page
    contentSecurityPolicy:
      process.env.NODE_ENV === "production"
        ? undefined // strict in production
        : false, // relaxed in development so Swagger UI loads correctly
  })
)
app.use(cors())
app.use(express.json())
app.use(requestLoggerMiddleware)

// ── API Documentation ─────────────────────────────────────────────────────
// Interactive Swagger UI — only in development
// In production: either disable it or protect with basic auth
if (process.env.NODE_ENV !== "production") {
  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: "Research Assistant API Docs",
      swaggerOptions: {
        // Remembers your JWT token between page refreshes
        persistAuthorization: true,
        // Collapses all endpoints by default — less overwhelming
        docExpansion: "none",
        // Show request duration in the response
        displayRequestDuration: true,
      },
    })
  )

  // Raw OpenAPI JSON spec — useful for importing into Postman or Insomnia
  app.get("/api/docs.json", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json")
    res.json(swaggerSpec)
  })
}

// ── Routes ────────────────────────────────────────────────────────────────
app.use("/", metricsRouter)
app.use("/api/v1/auth", authRouter)

// Health check
app.get("/health", async (_req: Request, res: Response) => {
  let dbStatus: "ok" | "error" = "ok"

  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (error: unknown) {
    dbStatus = "error"
    logError("Health check: database unreachable", error, {
      service: "HealthCheck",
    })
  }

  const allOk = dbStatus === "ok"

  res.status(allOk ? 200 : 503).json(
    ok({
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        api: "ok",
        db: dbStatus,
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
  console.log(`🔐 Auth           → http://localhost:${PORT}/api/v1/auth`)
})

export default app
