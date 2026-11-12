// backend/src/__tests__/ws.voice.session.test.ts
//
// Day 3a: voice protocol handling on the WS handler —
//   - binary frames routed BEFORE JSON parsing, rejected until auth
//   - voice_start / voice_end / barge_in control messages
//   - re-check that the user exists at auth AND at voice_start
//   - frame cap 4096 B, pacing (drop faster-than-real-time frames),
//     60 s utterance cap enforced by BYTE count (32 000 B/s),
//     10-minute session cap
// No provider is ever called (Day 5 wires STT).

import type WebSocket from "ws"

// ── Mock Redis (limiter + budget are wired at voice_start in Day 3b) ──────
interface FakePipeline {
  incr: (key?: string) => FakePipeline
  incrby: (key?: string) => FakePipeline
  expire: (key?: string) => FakePipeline
  ttl: (key?: string) => FakePipeline
  exec: () => Promise<unknown>
}
// Keys observed by consumeRateLimit — asserted by the quota tests.
const mockRedisKeys: string[] = []
// Per-call exec overrides (queue), default = allowed (count 1, ttl 60).
let mockExecQueue: unknown[][] = []
const defaultExec: unknown[] = [
  [null, 1],
  [null, 1],
  [null, 60],
]
const mockRedis = {
  multi: jest.fn((): FakePipeline => {
    const pipeline: FakePipeline = {
      incr: (key?: string): FakePipeline => {
        if (key !== undefined) mockRedisKeys.push(key)
        return pipeline
      },
      incrby: (key?: string): FakePipeline => {
        if (key !== undefined) mockRedisKeys.push(key)
        return pipeline
      },
      expire: (): FakePipeline => pipeline,
      ttl: (): FakePipeline => pipeline,
      exec: async (): Promise<unknown> => mockExecQueue.shift() ?? defaultExec,
    }
    return pipeline
  }),
  eval: jest.fn(async (): Promise<unknown> => [1, 1]),
  get: jest.fn(async (): Promise<string | null> => null),
  ttl: jest.fn(async (): Promise<number> => -1),
  del: jest.fn(async (): Promise<number> => 0),
}
jest.mock("../utils/redis", () => ({ redis: mockRedis, default: mockRedis }))

// ── Controllable JWT verification ─────────────────────────────────────────
let mockExp: number | undefined
jest.mock("../utils/jwt.utils", () => ({
  verifyAccessToken: jest.fn(() => ({
    userId: "user-ws",
    email: "ws@test.local",
    role: "USER" as const,
    exp: mockExp ?? Math.floor(Date.now() / 1000) + 3600,
  })),
}))

// ── Prisma: the user-existence re-check is under test ─────────────────────
const mockFindUnique = jest.fn(async (): Promise<{ id: string } | null> => ({ id: "user-ws" }))
jest.mock("../utils/prisma", () => ({
  prisma: {
    user: {
      findUnique: mockFindUnique,
    },
  },
}))

// ── Streaming agent mocked so no Gemini call can happen ───────────────────
jest.mock("../services/streaming.agent.service", () => ({
  StreamingAgentService: class {
    run = jest.fn().mockResolvedValue(undefined)
  },
}))

// ── Module under test (required AFTER the mocks) ──────────────────────────
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-key-not-a-real-secret"

const { AgentWsHandler } =
  require("../websocket/agent.ws.handler") as typeof import("../websocket/agent.ws.handler")

// ── Helpers ───────────────────────────────────────────────────────────────

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

type Listener = (...args: unknown[]) => void

class FakeWebSocket {
  readyState = 1 // OPEN
  readonly sent: string[] = []
  readonly close = jest.fn()
  private readonly listeners = new Map<string, Listener[]>()

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args)
    }
  }

  send(data: string): void {
    this.sent.push(data)
  }
}

interface ParsedMessage {
  type: string
  code?: string
  sessionId?: string
  message?: string
}

describe("voice session (Day 3a)", () => {
  let ws: FakeWebSocket
  let handler: InstanceType<typeof AgentWsHandler>

  const parsed = (): ParsedMessage[] => ws.sent.map(raw => JSON.parse(raw) as ParsedMessage)
  const voiceErrors = (): ParsedMessage[] => parsed().filter(m => m.type === "voice_error")
  const errors = (): ParsedMessage[] => parsed().filter(m => m.type === "error")

  function makeHandler(): FakeWebSocket {
    const socket = new FakeWebSocket()
    handler = new AgentWsHandler(socket as unknown as WebSocket)
    return socket
  }

  async function makeAuthenticated(): Promise<FakeWebSocket> {
    ws = makeHandler()
    ws.emit("message", JSON.stringify({ type: "auth", token: "test-token" }))
    await flush()
    return ws
  }

  async function startVoice(sessionId = "v1"): Promise<void> {
    ws.emit("message", JSON.stringify({ type: "voice_start", sessionId }))
    await flush()
  }

  function sendAudio(byteLength: number): void {
    ws.emit("message", Buffer.alloc(byteLength), true) // isBinary = true
  }

  beforeEach(() => {
    mockRedisStoreReset()
    jest.clearAllMocks()
    mockExp = undefined
    mockExecQueue = []
    mockRedisKeys.length = 0
    mockFindUnique.mockImplementation(async () => ({ id: "user-ws" }))
  })

  function mockRedisStoreReset(): void {
    // The redis mock has no shared store — nothing to clear, kept for
    // symmetry with the other suites and future Day 3b wiring.
  }

  // ── Binary before JSON / before auth ────────────────────────────────────
  describe("binary routing and pre-auth rejection", () => {
    it("rejects binary frames before auth completes", async () => {
      ws = makeHandler()
      sendAudio(100)

      expect(voiceErrors()).toHaveLength(1)
      expect(voiceErrors()[0]).toMatchObject({ code: "NOT_AUTHENTICATED" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
    })

    it("accepts audio only after auth + voice_start", async () => {
      await makeAuthenticated()
      await startVoice()
      const before = voiceErrors().length

      sendAudio(100)

      expect(voiceErrors()).toHaveLength(before)
      const diag = handler.getVoiceDiagnostics()
      expect(diag.sessionId).toBe("v1")
      expect(diag.bytesReceived).toBe(100)
      expect(diag.utteranceOpen).toBe(true)
    })

    it("routes voice JSON messages without breaking the text protocol", async () => {
      await makeAuthenticated()
      await startVoice()
      ws.emit("message", JSON.stringify({ type: "ping" }))

      expect(parsed().some(m => m.type === "pong")).toBe(true)
      expect(errors()).toHaveLength(0)
    })
  })

  // ── voice_start ─────────────────────────────────────────────────────────
  describe("voice_start", () => {
    it("refuses without auth", async () => {
      ws = makeHandler()
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "NOT_AUTHENTICATED", sessionId: "v1" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
    })

    it("re-checks the user exists — deleted account is refused", async () => {
      await makeAuthenticated()
      mockFindUnique.mockResolvedValueOnce(null) // deleted between connect and voice_start
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "NOT_AUTHENTICATED" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
    })

    it("refuses when the DB is unreachable (fail closed)", async () => {
      await makeAuthenticated()
      mockFindUnique.mockRejectedValueOnce(new Error("db down"))
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "VOICE_INTERNAL" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
    })

    it("closes with 4001 when the token expired since auth", async () => {
      mockExp = Math.floor(Date.now() / 1000) - 60
      await makeAuthenticated()
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "TOKEN_EXPIRED" })
      expect(ws.close).toHaveBeenCalledWith(4001, "token expired")
    })

    it("voice_start while the text agent runs is allowed (independent state)", async () => {
      await makeAuthenticated()
      await startVoice()
      expect(voiceErrors()).toHaveLength(0)
      expect(handler.getVoiceDiagnostics().sessionId).toBe("v1")
    })
  })

  // ── Quota gates (Day 3b) ────────────────────────────────────────────────
  describe("quota gates at voice_start", () => {
    it("charges session + turn limiter and the daily budget on a new session", async () => {
      await makeAuthenticated()
      await startVoice()

      expect(mockRedisKeys).toContain("rl:voice_session:user-ws")
      expect(mockRedisKeys).toContain("rl:voice_turn:user-ws")
      expect(mockRedis.eval).toHaveBeenCalledTimes(1)
      expect(voiceErrors()).toHaveLength(0)
      expect(handler.getVoiceDiagnostics().sessionId).toBe("v1")
    })

    it("same-session restart charges the turn again but not the session slot", async () => {
      await makeAuthenticated()
      await startVoice()
      await startVoice() // same sessionId → utterance restart

      const sessionCharges = mockRedisKeys.filter(k => k === "rl:voice_session:user-ws").length
      const turnCharges = mockRedisKeys.filter(k => k === "rl:voice_turn:user-ws").length
      expect(sessionCharges).toBe(1)
      expect(turnCharges).toBe(2)
      expect(mockRedis.eval).toHaveBeenCalledTimes(2)
      expect(voiceErrors()).toHaveLength(0)
    })

    it("session limiter refusal is VOICE_RATE_LIMITED and creates no session", async () => {
      // Session slot over its 10/h cap.
      mockExecQueue = [
        [
          [null, 11],
          [null, 1],
          [null, 60],
        ],
      ]
      await makeAuthenticated()
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "VOICE_RATE_LIMITED" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
      expect(mockRedis.eval).not.toHaveBeenCalled() // fail fast, no budget spent
    })

    it("turn limiter refusal is VOICE_RATE_LIMITED (session charge already spent)", async () => {
      // First call (session) allowed, second call (turn) over the 20/h cap.
      mockExecQueue = [
        defaultExec,
        [
          [null, 21],
          [null, 1],
          [null, 60],
        ],
      ]
      await makeAuthenticated()
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "VOICE_RATE_LIMITED" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
      expect(mockRedis.eval).not.toHaveBeenCalled()
    })

    it("budget refusal is VOICE_CAPACITY_REACHED and creates no session", async () => {
      ;(mockRedis.eval as jest.Mock).mockResolvedValueOnce([-1, -1]) // cap hit
      await makeAuthenticated()
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "VOICE_CAPACITY_REACHED" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
    })

    it("limiter Redis failure fails closed (VOICE_RATE_LIMITED, no session)", async () => {
      mockExecQueue = [[]] // malformed reply → consumeRateLimit throws → closed
      await makeAuthenticated()
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "VOICE_RATE_LIMITED" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
    })

    it("budget Redis failure fails closed (VOICE_CAPACITY_REACHED)", async () => {
      ;(mockRedis.eval as jest.Mock).mockRejectedValueOnce(new Error("redis down"))
      await makeAuthenticated()
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "VOICE_CAPACITY_REACHED" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
    })
  })

  // ── voice_end / barge_in ────────────────────────────────────────────────
  describe("voice_end and barge_in", () => {
    it("voice_end without a session is NO_VOICE_SESSION", async () => {
      await makeAuthenticated()
      ws.emit("message", JSON.stringify({ type: "voice_end", sessionId: "v1" }))

      expect(voiceErrors()[0]).toMatchObject({ code: "NO_VOICE_SESSION" })
    })

    it("voice_end closes the utterance but keeps the session", async () => {
      await makeAuthenticated()
      await startVoice()
      sendAudio(64)
      ws.emit("message", JSON.stringify({ type: "voice_end", sessionId: "v1" }))

      const diag = handler.getVoiceDiagnostics()
      expect(diag.sessionId).toBe("v1")
      expect(diag.utteranceOpen).toBe(false)
      expect(voiceErrors()).toHaveLength(0)
    })

    it("audio after voice_end is NO_VOICE_SESSION", async () => {
      await makeAuthenticated()
      await startVoice()
      ws.emit("message", JSON.stringify({ type: "voice_end", sessionId: "v1" }))
      sendAudio(64)

      expect(voiceErrors()[0]).toMatchObject({ code: "NO_VOICE_SESSION" })
    })

    it("barge_in is accepted with a session and ignored without one", async () => {
      await makeAuthenticated()
      ws.emit("message", JSON.stringify({ type: "barge_in", sessionId: "v1" }))
      expect(voiceErrors()).toHaveLength(0)

      await startVoice()
      ws.emit("message", JSON.stringify({ type: "barge_in", sessionId: "v1" }))
      expect(voiceErrors()).toHaveLength(0)
    })

    it("voice_start on the same session restarts the utterance, keeps the clock", async () => {
      await makeAuthenticated()
      await startVoice()
      sendAudio(3200)
      const firstStart = handler.getVoiceDiagnostics().startedAtMs

      await startVoice() // same sessionId

      const diag = handler.getVoiceDiagnostics()
      expect(diag.bytesReceived).toBe(0)
      expect(diag.utteranceOpen).toBe(true)
      expect(diag.startedAtMs).toBe(firstStart)
    })

    it("a different sessionId replaces the session", async () => {
      await makeAuthenticated()
      await startVoice("v1")
      await startVoice("v2")

      expect(handler.getVoiceDiagnostics().sessionId).toBe("v2")
    })
  })

  // ── Frame cap, pacing, byte-counted caps (fake clock) ───────────────────
  describe("caps and pacing", () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ["setImmediate"] })
      jest.setSystemTime(1_700_000_000_000)
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it("rejects frames over 4096 bytes without counting them", async () => {
      await makeAuthenticated()
      await startVoice()

      sendAudio(4097)

      expect(voiceErrors()[0]).toMatchObject({ code: "FRAME_TOO_LARGE" })
      expect(handler.getVoiceDiagnostics().bytesReceived).toBe(0)
    })

    it("drops frames arriving faster than real time (2 s burst allowance)", async () => {
      await makeAuthenticated()
      await startVoice()

      // 16 × 4096 B at t=0: allowed = 64 000 B, so the 16th frame is dropped.
      for (let i = 0; i < 16; i++) {
        sendAudio(4096)
      }

      const diag = handler.getVoiceDiagnostics()
      expect(diag.bytesReceived).toBe(15 * 4096) // 61 440 counted
      expect(diag.droppedFrames).toBe(1)
      expect(voiceErrors()).toHaveLength(0) // drops are silent, not errors
    })

    it("enforces the 60 s utterance cap by counting bytes", async () => {
      await makeAuthenticated()
      await startVoice()

      const start = handler.getVoiceDiagnostics().startedAtMs
      // 60 s = 1 920 000 B ⇒ 468 full frames fit (1 916 928 B), the 469th
      // overshoots the cap. Advance the clock just enough per frame to
      // satisfy the pacing rule.
      for (let frame = 1; frame <= 469; frame++) {
        const neededMs = Math.max(0, Math.ceil((4096 * frame - 64_000) / 32))
        jest.setSystemTime(start + neededMs)
        sendAudio(4096)
      }

      expect(voiceErrors()).toHaveLength(1)
      expect(voiceErrors()[0]).toMatchObject({ code: "UTTERANCE_TOO_LONG" })
      const diag = handler.getVoiceDiagnostics()
      expect(diag.utteranceOpen).toBe(false) // utterance over, session survives
      expect(diag.sessionId).toBe("v1")
      expect(diag.bytesReceived).toBe(468 * 4096) // just under 60 s of audio
    })

    it("voice_start after the 10-minute session cap is SESSION_LIMIT", async () => {
      await makeAuthenticated()
      await startVoice()

      jest.setSystemTime(1_700_000_000_000 + 10 * 60_000 + 1_000)
      await startVoice()

      expect(voiceErrors()[0]).toMatchObject({ code: "SESSION_LIMIT" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
    })

    it("audio after the 10-minute session cap is SESSION_LIMIT", async () => {
      await makeAuthenticated()
      await startVoice()

      jest.setSystemTime(1_700_000_000_000 + 10 * 60_000 + 1_000)
      sendAudio(32)

      expect(voiceErrors()[0]).toMatchObject({ code: "SESSION_LIMIT" })
      expect(handler.getVoiceDiagnostics().sessionId).toBeNull()
    })
  })
})

export {}
