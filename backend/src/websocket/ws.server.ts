// backend/src/websocket/ws.server.ts
// Creates and configures the WebSocket server.
// Attaches it to the existing HTTP server (not a separate port).
//
// WHY SAME PORT AS HTTP?
// Sharing port 3001 for both HTTP and WebSocket means:
//   - No extra firewall rules needed
//   - NGINX reverse proxy handles both with one upstream
//   - Simpler deployment configuration
//
// HOW IT WORKS:
// The ws library detects the Upgrade header on incoming requests.
// If it is an HTTP Upgrade to WebSocket: ws handles it.
// If it is a normal HTTP request: Express handles it.
// Both share the same port 3001.

import { WebSocketServer, type WebSocket } from "ws"
import type { Server } from "http"
import { AgentWsHandler } from "./agent.ws.handler"
import { logStartup, logRagEvent } from "../utils/logger"

// Heartbeat configuration
// Sends a ping every 30 seconds to detect dead connections.
// If a client does not respond within 30 seconds, it is terminated.
const HEARTBEAT_INTERVAL_MS = 30_000

// ── Extended WebSocket type with heartbeat tracking ───────────────────────
interface WsWithHeartbeat extends WebSocket {
  isAlive: boolean
}

export function createWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws/agent", // WebSocket endpoint: ws://localhost:3001/ws/agent
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
