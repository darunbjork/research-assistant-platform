import { WebSocketServer, type WebSocket } from "ws"
import type { Server } from "http"
import { AgentWsHandler } from "./agent.ws.handler"
import { logStartup, logRagEvent } from "../utils/logger"

// Heartbeat configuration
// Sends a ping every 30 seconds to detect dead connections.
// If a client does not respond within 30 seconds, it is terminated.
const HEARTBEAT_INTERVAL_MS = 30_000

// Messages are small JSON — a 64 KiB cap stops a client from flooding us
// with multi-megabyte frames and exhausting memory.
const MAX_PAYLOAD_BYTES = 64 * 1024

// Origins the browser client may connect from. CORS_ORIGINS (env schema,
// task 3.1) overrides; until then the defaults mirror app.ts's cors() list.
const DEFAULT_ORIGINS = ["http://localhost:5174", "http://localhost:3001", "http://localhost:5173"]

function allowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS
  if (raw === undefined || raw.trim() === "") return DEFAULT_ORIGINS
  return raw
    .split(",")
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0)
}

// ── Extended WebSocket type with heartbeat tracking ───────────────────────
interface WsWithHeartbeat extends WebSocket {
  isAlive: boolean
}

export function createWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws/agent", // WebSocket endpoint: ws://localhost:3001/ws/agent
    maxPayload: MAX_PAYLOAD_BYTES,
  })

  logStartup("WebSocket server ready", {
    service: "WsServer",
    path: "/ws/agent",
  })

  // ── Connection handler ─────────────────────────────────────────────────
  wss.on("connection", (ws: WebSocket, req) => {
    const clientIp = req.socket.remoteAddress ?? "unknown"

    logRagEvent("agent_step", "WebSocket client connected", {
      service: "WsServer",
      clientIp: clientIp.replace("::ffff:", ""), // strip IPv4-in-IPv6 prefix
    })

    // Origin check (D-defence): browsers always send Origin on a WS
    // upgrade; anything not on the allowlist is closed with 1008
    // (policy violation). Skipped under NODE_ENV=test so unit tests can
    // connect without configuring origins.
    if (process.env.NODE_ENV !== "test") {
      const origin = req.headers.origin
      if (origin === undefined || !allowedOrigins().includes(origin)) {
        logRagEvent("agent_step", "WebSocket connection rejected: origin not allowed", {
          service: "WsServer",
          clientIp: clientIp.replace("::ffff:", ""),
          origin: origin ?? "none",
        })
        ws.close(1008, "origin not allowed")
        return
      }
    }

    // Mark as alive for heartbeat tracking
    ;(ws as WsWithHeartbeat).isAlive = true

    // Reset alive flag on pong response
    ws.on("pong", () => {
      ;(ws as WsWithHeartbeat).isAlive = true
    })

    // Create a handler for this client — manages the full session lifecycle
    new AgentWsHandler(ws)
  })

  // ── Heartbeat interval ─────────────────────────────────────────────────
  // Detects and terminates zombie connections (client closed without proper close).
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const wsWithHb = ws as WsWithHeartbeat

      if (!wsWithHb.isAlive) {
        // Client did not respond to last ping — terminate it
        logRagEvent("agent_step", "Terminating dead WebSocket connection", {
          service: "WsServer",
        })
        ws.terminate()
        return
      }

      wsWithHb.isAlive = false
      ws.ping() // send ping — client should respond with pong
    })
  }, HEARTBEAT_INTERVAL_MS)

  // Clean up the interval when the WebSocket server closes
  wss.on("close", () => {
    clearInterval(heartbeat)
  })

  return wss
}
