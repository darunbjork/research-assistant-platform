import type WebSocket from "ws"
import { prisma } from "../utils/prisma"
import { verifyAccessToken } from "../utils/jwt.utils"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { GenerationService } from "../services/generation.service"
import { StreamingAgentService } from "../services/streaming.agent.service"
import { parseClientMessage, toJson, type ServerMessage } from "../types/websocket.types"
import { logRagEvent, logError } from "../utils/logger"
import { consumeRateLimit, AGENT_LIMIT } from "../middleware/rate-limit.middleware"
import { consumeGlobalBudget } from "../utils/global-budget"
import { MAX_QUERY_LENGTH } from "../middleware/validate.middleware"
import redis from "../utils/redis"
import { env } from "../config/env"

// ── Hardening constants (task 2.8) ────────────────────────────────────────
// No successful auth within this window ⇒ close the connection.
const AUTH_TIMEOUT_MS = 10_000
// Application close codes (4000-4999 range is reserved for applications).
const CLOSE_AUTH_TIMEOUT = 4001
const CLOSE_TOKEN_EXPIRED = 4001

// ── Service Instances ─────────────────────────────────────────────────────
// Shared across all WebSocket connections — created once at module load.
// This is safe because the services are stateless (no per-connection state).
const embeddingService = new EmbeddingService(env.GEMINI_API_KEY, redis)
const hybridSearchService = new HybridSearchService(prisma, embeddingService)
const generationService = new GenerationService(env.GEMINI_API_KEY)

// ── Handler Class ─────────────────────────────────────────────────────────

export class AgentWsHandler {
  private userId: string | null = null // null until authenticated
  private isRunning: boolean = false // true while agent is executing
  /** Aborts the in-flight agent run when the connection closes. */
  private runController: AbortController | null = null
  /** `exp` (seconds since epoch) of the token accepted at auth time. */
  private tokenExp: number | null = null
  private authTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly ws: WebSocket) {
    // Auth timeout: a connection that never authenticates is closed (4001)
    // so an open socket can't sit around forever consuming resources.
    this.authTimer = setTimeout(() => {
      if (this.userId === null) {
        logRagEvent("agent_step", "WebSocket auth timeout — closing connection", {
          service: "AgentWsHandler",
        })
        this.ws.close(CLOSE_AUTH_TIMEOUT, "authentication timeout")
      }
    }, AUTH_TIMEOUT_MS)

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
      this.clearAuthTimer()
      // Client went away — cancel any in-flight agent run (task 2.9).
      this.runController?.abort()
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
      this.tokenExp = payload.exp ?? null
      this.clearAuthTimer()

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

    // The access token may expire while the connection stays open (15m in
    // production). Frontend reconnects and re-authenticates (task 3.6).
    if (this.tokenExp !== null && Date.now() / 1000 > this.tokenExp) {
      this.send({
        type: "error",
        sessionId,
        message: "Access token expired. Please reconnect and re-authenticate.",
        code: "TOKEN_EXPIRED",
      })
      this.ws.close(CLOSE_TOKEN_EXPIRED, "token expired")
      return
    }

    // AGENT_LIMIT applies to WebSocket starts exactly as it does to HTTP.
    const decision = await consumeRateLimit(this.userId, AGENT_LIMIT)
    if (!decision.allowed) {
      this.send({
        type: "error",
        sessionId,
        message: AGENT_LIMIT.message,
        code: "RATE_LIMITED",
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

    if (query.length > MAX_QUERY_LENGTH) {
      this.send({
        type: "error",
        sessionId,
        message: `Query too long. Maximum ${MAX_QUERY_LENGTH} characters.`,
        code: "INVALID_QUERY",
      })
      return
    }

    // Global daily budget: an agent run costs 5 units. Fails closed.
    if (!(await consumeGlobalBudget(5))) {
      this.send({
        type: "error",
        sessionId,
        message: "Daily capacity reached, try again tomorrow",
        code: "CAPACITY_REACHED",
      })
      return
    }

    this.isRunning = true
    const runController = new AbortController()
    this.runController = runController

    logRagEvent("agent_step", "Streaming agent session started via WebSocket", {
      service: "AgentWsHandler",
      sessionId,
      userId: this.userId,
    })

    try {
      // Create the streaming agent with the send callback
      const streamingAgent = new StreamingAgentService(
        env.GEMINI_API_KEY,
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

      await streamingAgent.run(query.trim(), this.userId, sessionId, onEvent, runController.signal)
    } catch (error: unknown) {
      // Aborted by a client disconnect: info-level only, no error message.
      if (runController.signal.aborted) {
        logRagEvent("agent_step", "Streaming agent run aborted (connection closed)", {
          service: "AgentWsHandler",
          sessionId,
          userId: this.userId,
        })
        return
      }

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
      this.runController = null
    }
  }

  // ── Auth Timeout Helper ────────────────────────────────────────────────
  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer)
      this.authTimer = null
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
