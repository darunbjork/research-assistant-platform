import type WebSocket from "ws"
import { PrismaClient } from "@prisma/client"
import { verifyAccessToken } from "../utils/jwt.utils"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { GenerationService } from "../services/generation.service"
import { StreamingAgentService } from "../services/streaming.agent.service"
import { parseClientMessage, toJson, type ServerMessage } from "../types/websocket.types"
import { logRagEvent, logError } from "../utils/logger"
import redis from "../utils/redis"

// ── Service Instances ─────────────────────────────────────────────────────
// Shared across all WebSocket connections — created once at module load.
// This is safe because the services are stateless (no per-connection state).
const prisma = new PrismaClient()
const embeddingService = new EmbeddingService(process.env.GEMINI_API_KEY ?? "", redis)
const hybridSearchService = new HybridSearchService(prisma, embeddingService)
const generationService = new GenerationService(process.env.GEMINI_API_KEY ?? "")

// ── Handler Class ─────────────────────────────────────────────────────────

export class AgentWsHandler {
  private userId: string | null = null // null until authenticated
  private isRunning: boolean = false // true while agent is executing

  constructor(private readonly ws: WebSocket) {
    this.setup()
  }

  // ── Setup ─────────────────────────────────────────────────────────────
  // Registers WebSocket event listeners.
  private setup(): void {
    // Send initial connected message
    this.send({
      type: "connected",
      sessionId: "pending-auth",
      message: "Connected to ResearchBot. Please authenticate.",
    })

    // Handle incoming messages from the client
    this.ws.on("message", (raw: Buffer | string) => {
      void this.handleMessage(raw.toString())
    })

    // Handle connection close
    this.ws.on("close", (_code: number, _reason: Buffer) => {
      logRagEvent("agent_step", "WebSocket connection closed", {
        service: "AgentWsHandler",
        userId: this.userId ?? "unauthenticated",
      })
    })

    // Handle errors
    this.ws.on("error", (error: Error) => {
      logError("WebSocket error", error, {
        service: "AgentWsHandler",
        userId: this.userId ?? "unauthenticated",
      })
    })
  }

  // ── Handle Incoming Message ────────────────────────────────────────────
  private async handleMessage(rawText: string): Promise<void> {
    const message = parseClientMessage(rawText)

    if (message === null) {
      this.send({
        type: "error",
        sessionId: "unknown",
        message: "Invalid message format. Expected JSON with a 'type' field.",
        code: "INVALID_MESSAGE",
      })
      return
    }

    switch (message.type) {
      case "ping":
        this.send({ type: "pong" })
        break

      case "auth":
        await this.handleAuth(message.token)
        break

      case "start":
        await this.handleStart(message.query, message.sessionId)
        break
    }
  }

  // ── Handle Authentication ──────────────────────────────────────────────
  private async handleAuth(token: string): Promise<void> {
    // Strip "Bearer " prefix if present
    const cleanToken = token.startsWith("Bearer ") ? token.slice(7) : token

    try {
      const payload = verifyAccessToken(cleanToken)
      this.userId = payload.userId

      this.send({
        type: "auth_confirmed",
        userId: payload.userId,
      })

      logRagEvent("agent_step", "WebSocket client authenticated", {
        service: "AgentWsHandler",
        userId: payload.userId,
      })
    } catch (error: unknown) {
      this.send({
        type: "error",
        sessionId: "auth",
        message: "Authentication failed. Please provide a valid access token.",
        code: "AUTH_FAILED",
      })

      logError("WebSocket auth failed", error, {
        service: "AgentWsHandler",
      })
    }
  }

  // ── Handle Agent Start ─────────────────────────────────────────────────
  private async handleStart(query: string, sessionId: string): Promise<void> {
    // Must be authenticated first
    if (this.userId === null) {
      this.send({
        type: "error",
        sessionId,
        message: "Authentication required before starting an agent session.",
        code: "NOT_AUTHENTICATED",
      })
      return
    }

    // Prevent concurrent sessions on the same connection
    if (this.isRunning) {
      this.send({
        type: "error",
        sessionId,
        message: "An agent session is already running on this connection.",
        code: "SESSION_BUSY",
      })
      return
    }

    if (!query || query.trim() === "") {
      this.send({
        type: "error",
        sessionId,
        message: "Query cannot be empty.",
        code: "INVALID_QUERY",
      })
      return
    }

    this.isRunning = true

    logRagEvent("agent_step", "Streaming agent session started via WebSocket", {
      service: "AgentWsHandler",
      sessionId,
      userId: this.userId,
    })

    try {
      // Create the streaming agent with the send callback
      const streamingAgent = new StreamingAgentService(
        process.env.GEMINI_API_KEY ?? "",
        hybridSearchService,
        generationService
      )

      // The onEvent callback converts each ServerMessage into a WebSocket send
      const onEvent = (message: ServerMessage): void => {
        // Check connection is still open before sending
        if (this.ws.readyState === 1) {
          // 1 = OPEN
          this.send(message)
        }
      }

      await streamingAgent.run(query.trim(), this.userId, sessionId, onEvent)
    } catch (error: unknown) {
      logError("Streaming agent failed", error, {
        service: "AgentWsHandler",
        sessionId,
        userId: this.userId,
      })

      this.send({
        type: "error",
        sessionId,
        message: error instanceof Error ? error.message : "Agent session failed unexpectedly.",
        code: "AGENT_ERROR",
      })
    } finally {
      this.isRunning = false
    }
  }

  // ── Send Helper ────────────────────────────────────────────────────────
  // Type-safe wrapper around ws.send().
  // Never throws — if the connection is closed, the send is silently dropped.
  private send(message: ServerMessage): void {
    try {
      if (this.ws.readyState === 1) {
        // 1 = WebSocket.OPEN
        this.ws.send(toJson(message))
      }
    } catch (error: unknown) {
      logError("Failed to send WebSocket message", error, {
        service: "AgentWsHandler",
      })
    }
  }
}
