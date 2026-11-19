// backend/src/__tests__/ws.voice.disabled.test.ts
//
// Defence in depth for the voice capability (config/capabilities.ts):
// with the DEFAULT config (VOICE_MOCK=true, TTS_PROVIDER=mock — production
// today) the WS handler must refuse voice_start with VOICE_DISABLED before
// touching auth re-checks, rate limits or any upstream, and refuse
// set_speak {enabled: true} with TTS_DISABLED. The capability module is
// NOT mocked here: this runs the real config path.

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
const mockStreamingRun = jest.fn(
  async (
    _query: string,
    _userId: string,
    _sessionId: string,
    _onEvent: unknown,
    _signal?: AbortSignal
  ): Promise<undefined> => undefined
)
jest.mock("../services/streaming.agent.service", () => ({
  StreamingAgentService: class {
    run = mockStreamingRun
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

describe("voice disabled by config (VOICE_MOCK=true, TTS_PROVIDER=mock)", () => {
  let ws: FakeWebSocket

  const parsed = (): ParsedMessage[] => ws.sent.map(raw => JSON.parse(raw) as ParsedMessage)
  const voiceErrors = (): ParsedMessage[] => parsed().filter(m => m.type === "voice_error")

  async function makeAuthenticated(): Promise<FakeWebSocket> {
    const socket = new FakeWebSocket()
    new AgentWsHandler(socket as unknown as WebSocket)
    socket.emit("message", JSON.stringify({ type: "auth", token: "test-token" }))
    await flush()
    return socket
  }

  function send(message: object): void {
    ws.emit("message", JSON.stringify(message))
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    mockRedisKeys.length = 0
    mockExecQueue = []
    mockFindUnique.mockImplementation(async () => ({ id: "user-ws" }))
    ws = await makeAuthenticated()
    // Auth's own user re-check is not part of what's under test.
    mockFindUnique.mockClear()
    mockRedisKeys.length = 0
  })

  afterEach(async () => {
    ws.emit("close", 1000, Buffer.alloc(0))
    await flush()
  })

  it("rejects voice_start with VOICE_DISABLED and a clear message", async () => {
    send({ type: "voice_start", sessionId: "v1" })
    await flush()

    expect(voiceErrors()).toEqual([
      {
        type: "voice_error",
        sessionId: "v1",
        code: "VOICE_DISABLED",
        message: "Voice input is turned off on this server.",
      },
    ])
  })

  it("opens no voice session: no user re-check, no rate limit or budget charge", async () => {
    send({ type: "voice_start", sessionId: "v1" })
    await flush()

    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockRedisKeys).toEqual([])
    expect(mockRedis.eval).not.toHaveBeenCalled()

    // Nothing was opened, so ending the utterance finds no session.
    send({ type: "voice_end", sessionId: "v1" })
    await flush()
    expect(voiceErrors().map(m => m.code)).toEqual(["VOICE_DISABLED", "NO_VOICE_SESSION"])
  })

  it("refuses set_speak enabled with TTS_DISABLED", async () => {
    send({ type: "set_speak", enabled: true })
    await flush()

    expect(voiceErrors()).toEqual([
      {
        type: "voice_error",
        sessionId: "unknown",
        code: "TTS_DISABLED",
        message: "Spoken answers are turned off on this server.",
      },
    ])
  })

  it("accepts set_speak disabled silently", async () => {
    send({ type: "set_speak", enabled: false })
    await flush()

    expect(voiceErrors()).toEqual([])
  })

  it("still answers typed questions: only voice is off", async () => {
    send({ type: "start", query: "What is RAG?", sessionId: "s1" })
    await flush()

    expect(mockStreamingRun).toHaveBeenCalledTimes(1)
    expect(voiceErrors()).toEqual([])
  })
})
