// backend/src/__tests__/ws.server.test.ts
//
// Task 2.8 items 1-2: 64 KiB payload cap and the Origin allowlist on the
// WebSocket upgrade. AgentWsHandler is mocked so no services/API key are
// needed — only the connection gate is under test.

import WebSocket from "ws"
import { createServer, type Server } from "http"

// ── Mock the handler so only the gate is under test ───────────────────────
const mockHandlerConstruct = jest.fn()

jest.mock("../websocket/agent.ws.handler", () => ({
  AgentWsHandler: class {
    constructor(ws: {
      send(data: string): void
      on(event: "error", listener: (error: Error) => void): void
    }) {
      mockHandlerConstruct(ws)
      // The real handler attaches an error listener (protocol-level errors
      // such as "max payload size exceeded" are emitted as 'error').
      ws.on("error", () => {})
      ws.send(JSON.stringify({ type: "connected" }))
    }
  },
}))

// Required AFTER the mocks are defined (ts-jest hoists jest.mock above
// consts, but the factory only runs when the module is first required).
const { createWebSocketServer } =
  require("../websocket/ws.server") as typeof import("../websocket/ws.server")

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
}

interface ConnectResult {
  closed: boolean
  closeCode?: number
  closeReason?: string
  message?: string
}

describe("WebSocket server hardening (2.8)", () => {
  let httpServer: Server
  let port: number

  beforeAll(async () => {
    httpServer = createServer()
    createWebSocketServer(httpServer)
    await new Promise<void>(resolve => httpServer.listen(0, () => resolve()))
    const address = httpServer.address()
    if (address === null || typeof address === "string") {
      throw new Error("Could not determine test server port")
    }
    port = address.port
  })

  afterAll(async () => {
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
    if (ORIGINAL_ENV.NODE_ENV === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV
    }
    if (ORIGINAL_ENV.CORS_ORIGINS === undefined) {
      delete process.env.CORS_ORIGINS
    } else {
      process.env.CORS_ORIGINS = ORIGINAL_ENV.CORS_ORIGINS
    }
  })

  beforeEach(() => {
    mockHandlerConstruct.mockClear()
    // Origin checks are skipped under NODE_ENV=test; tests that exercise the
    // check switch it off explicitly.
    process.env.NODE_ENV = "test"
    delete process.env.CORS_ORIGINS
  })

  // Resolves on the first server message (the gate tests: an accepted
  // connection gets "connected", a rejected one gets a close frame).
  function connect(origin?: string): Promise<ConnectResult> {
    return new Promise(resolve => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
        headers: origin !== undefined ? { Origin: origin } : {},
      })

      const timer = setTimeout(() => {
        client.terminate()
        resolve({ closed: false })
      }, 2000)

      client.on("message", data => {
        clearTimeout(timer)
        client.terminate()
        resolve({ closed: false, message: data.toString() })
      })
      client.on("close", (code, reason) => {
        clearTimeout(timer)
        resolve({ closed: true, closeCode: code, closeReason: reason.toString() })
      })
      client.on("error", () => {
        /* close event follows */
      })
    })
  }

  // Resolves only on close (or timeout) — for tests where the server sends
  // a message on connect and the interesting event is the close frame.
  function connectUntilClose(origin: string | undefined, payload?: string): Promise<ConnectResult> {
    return new Promise(resolve => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
        headers: origin !== undefined ? { Origin: origin } : {},
      })

      const timer = setTimeout(() => {
        client.terminate()
        resolve({ closed: false })
      }, 2000)

      client.on("open", () => {
        if (payload !== undefined) client.send(payload)
      })
      client.on("close", (code, reason) => {
        clearTimeout(timer)
        resolve({ closed: true, closeCode: code, closeReason: reason.toString() })
      })
      client.on("error", () => {
        /* close event follows */
      })
    })
  }

  describe("origin check", () => {
    it("accepts an origin on the default allowlist and creates the handler", async () => {
      process.env.NODE_ENV = "development"

      const result = await connect("http://localhost:5173")

      expect(result.closed).toBe(false)
      expect(result.message).toContain("connected")
      expect(mockHandlerConstruct).toHaveBeenCalledTimes(1)
    })

    it("closes a disallowed origin with 1008 before creating the handler", async () => {
      process.env.NODE_ENV = "development"

      const result = await connect("http://evil.example.com")

      expect(result.closed).toBe(true)
      expect(result.closeCode).toBe(1008)
      expect(result.closeReason).toBe("origin not allowed")
      expect(mockHandlerConstruct).not.toHaveBeenCalled()
    })

    it("closes a connection with no Origin header", async () => {
      process.env.NODE_ENV = "development"

      const result = await connect(undefined)

      expect(result.closed).toBe(true)
      expect(result.closeCode).toBe(1008)
      expect(mockHandlerConstruct).not.toHaveBeenCalled()
    })

    it("honours CORS_ORIGINS as the allowlist", async () => {
      process.env.NODE_ENV = "development"
      process.env.CORS_ORIGINS = "https://research.example.com"

      const allowed = await connect("https://research.example.com")
      expect(allowed.closed).toBe(false)
      expect(mockHandlerConstruct).toHaveBeenCalledTimes(1)

      const rejected = await connect("http://localhost:5173")
      expect(rejected.closed).toBe(true)
      expect(rejected.closeCode).toBe(1008)
      expect(mockHandlerConstruct).toHaveBeenCalledTimes(1)
    })

    it("skips the check when NODE_ENV=test", async () => {
      const result = await connect("http://evil.example.com")

      expect(result.closed).toBe(false)
      expect(mockHandlerConstruct).toHaveBeenCalledTimes(1)
    })
  })

  describe("payload cap", () => {
    it("closes the connection when a frame exceeds 64 KiB", async () => {
      // NODE_ENV=test skips the origin check; the payload cap is protocol
      // level (maxPayload) and always active. 1009 = message too big.
      const oversized = "x".repeat(64 * 1024 + 1)

      const result = await connectUntilClose("http://localhost:5173", oversized)

      expect(result.closed).toBe(true)
      expect(result.closeCode).toBe(1009)
    })
  })
})

export {}
