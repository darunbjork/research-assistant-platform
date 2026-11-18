// backend/src/__tests__/ws.tts.speak.test.ts
//
// Spoken answers on the real WS handler (VOICE_TTS_PLAN Phase 4):
//   complete → tts_start → turn-tagged binary frames → tts_done
// with set_speak opt-in, per-user daily character cap (fails closed),
// barge-in / new question / close / shutdown cancellation, and failure
// isolation (a TTS failure never touches the text answer).
// TTS is a controllable in-memory stream — no provider is ever called.

import type WebSocket from "ws"

// ── Redis: rate limiter + daily TTS character counter ─────────────────────
const mockCharsStore = new Map<string, number>()
let mockCharsFailure = false
interface FakePipeline {
  incr: (key: string) => FakePipeline
  incrby: (key: string, by: number) => FakePipeline
  expire: (...args: unknown[]) => FakePipeline
  ttl: (key: string) => FakePipeline
  exec: () => Promise<unknown>
}
const mockRedis = {
  multi: jest.fn((): FakePipeline => {
    let charsOp: { key: string; by: number } | null = null
    const pipeline: FakePipeline = {
      incr: () => pipeline,
      incrby: (key: string, by: number) => {
        // Only the TTS counter is modelled; the LLM budget always allows.
        if (key.startsWith("tts:chars:")) charsOp = { key, by }
        return pipeline
      },
      expire: () => pipeline,
      ttl: () => pipeline,
      exec: async (): Promise<unknown> => {
        if (charsOp === null) {
          return [
            [null, 1],
            [null, 1],
            [null, 60],
          ]
        }
        if (mockCharsFailure) throw new Error("redis down")
        const total = (mockCharsStore.get(charsOp.key) ?? 0) + charsOp.by
        mockCharsStore.set(charsOp.key, total)
        return [
          [null, total],
          [null, 1],
        ]
      },
    }
    return pipeline
  }),
  eval: jest.fn(async (): Promise<unknown> => [1, 1]),
  get: jest.fn(async (): Promise<string | null> => null),
  ttl: jest.fn(async (): Promise<number> => -1),
  del: jest.fn(async (): Promise<number> => 0),
}
jest.mock("../utils/redis", () => ({ redis: mockRedis, default: mockRedis }))

jest.mock("../utils/jwt.utils", () => ({
  verifyAccessToken: jest.fn(() => ({
    userId: "user-tts",
    email: "tts@test.local",
    role: "USER" as const,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
}))

jest.mock("../utils/prisma", () => ({
  prisma: { user: { findUnique: jest.fn(async () => ({ id: "user-tts" })) } },
}))

// ── Agent: emits `complete` with a controllable answer and status ─────────
let mockAnswer = "The upload accepts PDF, TXT, MD and CSV [Evidence 1]."
let mockRunStatus: "done" | "aborted" = "done"
const mockStreamingRun = jest.fn(
  async (
    _query: string,
    _userId: string,
    sessionId: string,
    onEvent: (message: unknown) => void,
    _signal?: AbortSignal
  ): Promise<unknown> => {
    const result = {
      sessionId,
      finalAnswer: mockAnswer,
      citations: [],
      steps: [],
      iterationCount: 1,
      status: mockRunStatus,
      tokensUsed: 10,
      durationMs: 5,
    }
    if (mockRunStatus === "done") onEvent({ type: "complete", sessionId, result })
    return result
  }
)
jest.mock("../services/streaming.agent.service", () => ({
  StreamingAgentService: class {
    run = mockStreamingRun
  },
}))

// ── TTS: an in-memory stream we can pace, fail and observe ────────────────
let mockChunkCount = 5
let mockFailAfter: number | null = null
let mockFailWith: Error | null = null
const mockTtsRequests: Array<{ text: string; sessionId: string }> = []
jest.mock("../services/tts.service", () => {
  const actual: typeof import("../services/tts.service") =
    jest.requireActual("../services/tts.service")
  return {
    ...actual,
    getTtsService: () => ({
      async *synthesizeStream(
        request: { text: string; sessionId: string },
        signal: AbortSignal
      ): AsyncIterable<Buffer> {
        mockTtsRequests.push(request)
        for (let index = 0; index < mockChunkCount; index++) {
          await new Promise(resolve => setImmediate(resolve))
          if (signal.aborted) return
          if (mockFailAfter !== null && index >= mockFailAfter && mockFailWith !== null) {
            throw mockFailWith
          }
          yield Buffer.alloc(100, index)
        }
      },
    }),
  }
})

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-key-not-a-real-secret"

const { AgentWsHandler, abortRunningAgents } =
  require("../websocket/agent.ws.handler") as typeof import("../websocket/agent.ws.handler")
const { TtsError } =
  jest.requireActual<typeof import("../services/tts.service")>("../services/tts.service")
const { decodeTtsFrame, TTS_SAMPLE_RATE } =
  require("../types/voice.types") as typeof import("../types/voice.types")
const { dailyCharsKey } =
  require("../websocket/tts.speaker") as typeof import("../websocket/tts.speaker")

// ── Helpers ───────────────────────────────────────────────────────────────

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

type Listener = (...args: unknown[]) => void
type Wire = { kind: "json"; message: Record<string, unknown> } | { kind: "binary"; frame: Buffer }

class FakeWebSocket {
  readyState = 1
  bufferedAmount = 0
  readonly wire: Wire[] = []
  readonly close = jest.fn()
  private readonly listeners = new Map<string, Listener[]>()

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    if (Buffer.isBuffer(data) && options?.binary === true) {
      this.wire.push({ kind: "binary", frame: data })
    } else {
      this.wire.push({ kind: "json", message: JSON.parse(String(data)) as Record<string, unknown> })
    }
  }
}

describe("spoken answers over WebSocket (TTS Phase 4)", () => {
  let ws: FakeWebSocket

  const json = (type?: string): Array<Record<string, unknown>> =>
    ws.wire
      .filter((entry): entry is Extract<Wire, { kind: "json" }> => entry.kind === "json")
      .map(entry => entry.message)
      .filter(message => type === undefined || message.type === type)
  const frames = (): Array<ReturnType<typeof decodeTtsFrame>> =>
    ws.wire
      .filter((entry): entry is Extract<Wire, { kind: "binary" }> => entry.kind === "binary")
      .map(entry => decodeTtsFrame(entry.frame))

  async function until(condition: () => boolean, maxTicks = 200): Promise<void> {
    for (let tick = 0; tick < maxTicks && !condition(); tick++) await flush()
  }

  async function connect(speak: boolean): Promise<void> {
    ws = new FakeWebSocket()
    new AgentWsHandler(ws as unknown as WebSocket)
    ws.emit("message", JSON.stringify({ type: "auth", token: "t" }))
    await flush()
    ws.emit("message", JSON.stringify({ type: "set_speak", enabled: speak }))
    await flush()
  }

  function ask(sessionId = "q1"): void {
    ws.emit("message", JSON.stringify({ type: "start", query: "Which file types?", sessionId }))
  }

  const isDone = (): boolean => json("tts_done").length > 0 || json("voice_error").length > 0

  beforeEach(() => {
    jest.clearAllMocks()
    mockCharsStore.clear()
    mockCharsFailure = false
    mockAnswer = "The upload accepts PDF, TXT, MD and CSV [Evidence 1]."
    mockRunStatus = "done"
    mockChunkCount = 5
    mockFailAfter = null
    mockFailWith = null
    mockTtsRequests.length = 0
  })

  afterEach(async () => {
    ws?.emit("close", 1000, Buffer.alloc(0))
    await flush()
  })

  it("speaks a completed answer: complete → tts_start → ordered frames → tts_done", async () => {
    await connect(true)
    ask()
    await until(isDone)

    const order = ws.wire.map(entry => (entry.kind === "json" ? entry.message.type : "binary"))
    const completeAt = order.indexOf("complete")
    const startAt = order.indexOf("tts_start")
    expect(completeAt).toBeGreaterThanOrEqual(0)
    expect(startAt).toBeGreaterThan(completeAt)
    expect(order.indexOf("binary")).toBeGreaterThan(startAt)
    expect(order.lastIndexOf("binary")).toBeLessThan(order.indexOf("tts_done"))

    const [start] = json("tts_start")
    expect(start).toMatchObject({
      sessionId: "q1",
      turn: 1,
      sampleRate: TTS_SAMPLE_RATE,
      chars: "The upload accepts PDF, TXT, MD and CSV.".length,
    })
    expect(frames().map(frame => frame.seq)).toEqual([0, 1, 2, 3, 4])
    expect(frames().every(frame => frame.turn === 1 && frame.audio.length === 100)).toBe(true)
    expect(json("tts_done")).toEqual([{ type: "tts_done", sessionId: "q1", turn: 1 }])
  })

  it("speaks the cleaned text, never the citations", async () => {
    await connect(true)
    ask()
    await until(isDone)
    expect(mockTtsRequests).toEqual([
      { text: "The upload accepts PDF, TXT, MD and CSV.", sessionId: "q1" },
    ])
  })

  it("sends no TTS at all when speaking is off (the default)", async () => {
    ws = new FakeWebSocket()
    new AgentWsHandler(ws as unknown as WebSocket)
    ws.emit("message", JSON.stringify({ type: "auth", token: "t" }))
    await flush()
    ask()
    await until(() => json("complete").length > 0)
    for (let tick = 0; tick < 20; tick++) await flush()

    expect(json("tts_start")).toHaveLength(0)
    expect(frames()).toHaveLength(0)
    expect(mockTtsRequests).toHaveLength(0)
  })

  it("barge-in partway stops the frames and sends no tts_done", async () => {
    mockChunkCount = 50
    await connect(true)
    ask()
    await until(() => frames().length >= 2)

    ws.emit("message", JSON.stringify({ type: "barge_in", sessionId: "q1" }))
    const framesAtBargeIn = frames().length
    for (let tick = 0; tick < 30; tick++) await flush()

    expect(frames().length).toBeLessThanOrEqual(framesAtBargeIn + 1)
    expect(frames().length).toBeLessThan(50)
    expect(json("tts_done")).toHaveLength(0)
    expect(json("voice_error")).toHaveLength(0)
  })

  it("a new question interrupts the spoken answer and uses the next turn", async () => {
    mockChunkCount = 50
    await connect(true)
    ask("q1")
    await until(() => frames().length >= 1)

    mockChunkCount = 3
    ask("q2")
    await until(() => json("tts_done").length > 0)

    expect(json("tts_start").map(message => message.turn)).toEqual([1, 2])
    expect(json("tts_done")).toEqual([{ type: "tts_done", sessionId: "q2", turn: 2 }])
    expect(
      frames()
        .filter(frame => frame.turn === 2)
        .map(frame => frame.seq)
    ).toEqual([0, 1, 2])
  })

  it("voice_start stops the spoken answer (pressing the mic)", async () => {
    mockChunkCount = 50
    await connect(true)
    ask()
    await until(() => frames().length >= 1)

    ws.emit("message", JSON.stringify({ type: "voice_start", sessionId: "v1" }))
    for (let tick = 0; tick < 30; tick++) await flush()

    expect(frames().length).toBeLessThan(50)
    expect(json("tts_done")).toHaveLength(0)
  })

  it("set_speak false stops the current spoken answer", async () => {
    mockChunkCount = 50
    await connect(true)
    ask()
    await until(() => frames().length >= 1)

    ws.emit("message", JSON.stringify({ type: "set_speak", enabled: false }))
    for (let tick = 0; tick < 30; tick++) await flush()

    expect(frames().length).toBeLessThan(50)
    expect(json("tts_done")).toHaveLength(0)
  })

  it("socket close and shutdown both stop speaking", async () => {
    mockChunkCount = 50
    await connect(true)
    ask()
    await until(() => frames().length >= 1)
    abortRunningAgents()
    for (let tick = 0; tick < 30; tick++) await flush()
    expect(frames().length).toBeLessThan(50)
    expect(json("tts_done")).toHaveLength(0)

    const shutdownFrames = frames().length
    ask("q2")
    await until(() => frames().length > shutdownFrames)
    ws.emit("close", 1000, Buffer.alloc(0))
    const atClose = frames().length
    for (let tick = 0; tick < 30; tick++) await flush()
    expect(frames().length).toBeLessThanOrEqual(atClose + 1)
  })

  it("over the daily character cap → TTS_DAILY_LIMIT, text answer still delivered", async () => {
    mockCharsStore.set(dailyCharsKey("user-tts"), 19_990)
    await connect(true)
    ask()
    await until(isDone)

    expect(json("complete")).toHaveLength(1)
    expect(json("voice_error")).toEqual([
      expect.objectContaining({ code: "TTS_DAILY_LIMIT", sessionId: "q1" }),
    ])
    expect(json("tts_start")).toHaveLength(0)
    expect(mockTtsRequests).toHaveLength(0)
  })

  it("counts spoken characters per user per day", async () => {
    await connect(true)
    ask()
    await until(isDone)
    expect(mockCharsStore.get(dailyCharsKey("user-tts"))).toBe(
      "The upload accepts PDF, TXT, MD and CSV.".length
    )
  })

  it("a Redis error skips TTS (fails closed)", async () => {
    mockCharsFailure = true
    await connect(true)
    ask()
    await until(isDone)

    expect(json("complete")).toHaveLength(1)
    expect(json("tts_start")).toHaveLength(0)
    expect(mockTtsRequests).toHaveLength(0)
    expect(json("voice_error")[0]).toMatchObject({ code: "TTS_UNAVAILABLE" })
  })

  it.each([
    [
      "an outage",
      new TtsError("TTS_UNAVAILABLE", "Speech provider unavailable (HTTP 503)."),
      "TTS_UNAVAILABLE",
    ],
    ["a spent quota", new TtsError("TTS_QUOTA", "Speech quota reached."), "TTS_QUOTA"],
    [
      "bad credentials",
      new TtsError("TTS_AUTH", "Speech provider rejected the server credentials."),
      "TTS_FAILED",
    ],
  ])("a provider failure (%s) → voice_error, text answer unchanged", async (_name, error, code) => {
    mockFailAfter = 2
    mockFailWith = error
    await connect(true)
    ask()
    await until(isDone)

    const complete = json("complete")
    expect(complete).toHaveLength(1)
    expect((complete[0]?.result as { finalAnswer: string }).finalAnswer).toBe(mockAnswer)
    expect(json("voice_error")).toEqual([expect.objectContaining({ code, sessionId: "q1" })])
    expect(json("tts_done")).toHaveLength(0)
    expect(json("error")).toHaveLength(0)
  })

  it("an aborted agent run is never spoken", async () => {
    mockRunStatus = "aborted"
    await connect(true)
    ask()
    for (let tick = 0; tick < 30; tick++) await flush()
    expect(json("tts_start")).toHaveLength(0)
    expect(mockTtsRequests).toHaveLength(0)
  })

  it("an answer with nothing speakable (only citations) is skipped", async () => {
    mockAnswer = "[Evidence 1] [Evidence 2]"
    await connect(true)
    ask()
    for (let tick = 0; tick < 30; tick++) await flush()
    expect(json("tts_start")).toHaveLength(0)
    expect(mockCharsStore.size).toBe(0)
  })

  it("waits while the socket buffer is over 1 MB, then resumes", async () => {
    mockChunkCount = 3
    await connect(true)
    ws.bufferedAmount = 2 * 1024 * 1024
    ask()
    await until(() => json("tts_start").length > 0)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(frames()).toHaveLength(0)

    ws.bufferedAmount = 0
    await until(() => json("tts_done").length > 0, 400)
    expect(frames()).toHaveLength(3)
  })
})
