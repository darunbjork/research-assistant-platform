// backend/src/__tests__/voice.deepgram.session.test.ts
//
// Day 5 (MOCK-ONLY): the WS handler wired to the real DeepgramStream client,
// pointed at a LOCAL fake upstream via DEEPGRAM_WS_URL — no real network,
// no real key, no billing. Covers the handler-level requirements:
//   - voice_start → upstream open → audio forwarded → voice_end → Finalize
//     → transcript_final (delivered once) + persisted
//   - STT charged by bytes forwarded, converted to seconds (32 000 B/s),
//     through consumeVoiceBudget
//   - budget refusal mid-utterance fails closed (VOICE_CAPACITY_REACHED,
//     CloseStream, no further forwarding)
//   - HTTP 402 → VOICE_BUDGET_REACHED + breaker opens → next start fails
//     fast with PROVIDER_UNAVAILABLE (4xx handshake never counted)
//   - takeover: a second connection closes the old upstream and the old
//     connection gets NO_VOICE_SESSION (one live stream per user)
//   - close paths: voice_end, client close, session cap, shutdown all send
//     CloseStream then close
//   - mid-utterance drop → STT_FAILED, utterance stops

import type WebSocket from "ws"
import type { AddressInfo } from "net"
import { createServer, type Server as HttpServer } from "http"
import { WebSocketServer, type WebSocket as ServerSocket } from "ws"

// ── Env for real mode — set BEFORE the handler (and env.ts) load ──────────
process.env.VOICE_MOCK = "false"
process.env.DEEPGRAM_API_KEY = "dg-handler-key-0123456789"
process.env.ELEVENLABS_API_KEY = "el-handler-key-0123456789"
process.env.ELEVENLABS_VOICE_ID = "voice-id-test"
// DEEPGRAM_WS_URL is assigned in beforeAll once the fake upstream binds.

// ── Mocks (hoisted; factories never touch env.ts) ─────────────────────────

interface FakePipeline {
  incr: (key?: string) => FakePipeline
  incrby: (key?: string) => FakePipeline
  expire: (key?: string) => FakePipeline
  ttl: (key?: string) => FakePipeline
  exec: () => Promise<unknown>
}
const mockDefaultExec: unknown[] = [
  [null, 1],
  [null, 1],
  [null, 60],
]
const mockRedisEval = jest.fn<Promise<unknown>, unknown[]>(async (): Promise<unknown> => [1, 1])
const mockRedis = {
  multi: jest.fn((): FakePipeline => {
    const pipeline: FakePipeline = {
      incr: (): FakePipeline => pipeline,
      incrby: (): FakePipeline => pipeline,
      expire: (): FakePipeline => pipeline,
      ttl: (): FakePipeline => pipeline,
      exec: async (): Promise<unknown> => mockDefaultExec,
    }
    return pipeline
  }),
  eval: mockRedisEval,
  get: jest.fn(async (): Promise<string | null> => null),
  ttl: jest.fn(async (): Promise<number> => -1),
  del: jest.fn(async (): Promise<number> => 0),
}
jest.mock("../utils/redis", () => ({ redis: mockRedis, default: mockRedis }))

jest.mock("../utils/jwt.utils", () => ({
  verifyAccessToken: jest.fn(() => ({
    userId: "user-dg",
    email: "dg@test.local",
    role: "USER" as const,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
}))

jest.mock("../utils/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(async (): Promise<{ id: string } | null> => ({ id: "user-dg" })),
    },
  },
}))

jest.mock("../services/streaming.agent.service", () => ({
  StreamingAgentService: class {
    run = jest.fn().mockResolvedValue(undefined)
  },
}))

const mockSaveVoiceTranscript = jest.fn<Promise<null>, [input: unknown]>(
  async (): Promise<null> => null
)
jest.mock("../services/voice.transcript.service", () => ({
  saveVoiceTranscript: (input: unknown): Promise<null> => mockSaveVoiceTranscript(input),
  VOICE_TRANSCRIPT_RETENTION_DAYS: 30,
}))

type HandlerModule = typeof import("../websocket/agent.ws.handler")
type StreamModule = typeof import("../services/deepgram.stream")
type SttModule = typeof import("../services/stt.service")

// Loaded in beforeAll, after DEEPGRAM_WS_URL is known.
let AgentWsHandler: HandlerModule["AgentWsHandler"]
let closeAllVoiceUpstreams: StreamModule["closeAllVoiceUpstreams"]
let sttBreaker: SttModule["sttBreaker"]

// ── Fake upstream (single server for the whole file) ──────────────────────

interface FakeConnection {
  socket: ServerSocket
  texts: string[]
  binaries: Buffer[]
  closed: Promise<void>
}

let httpServer: HttpServer
let wss: WebSocketServer
let upstreamPort = 0
let rejectNextStatus: number | null = null
let connections: FakeConnection[] = []
let onConnection: ((connection: FakeConnection) => void) | null = null

async function startFakeUpstream(): Promise<void> {
  wss = new WebSocketServer({ noServer: true })
  httpServer = createServer()
  httpServer.on("upgrade", (request, socket, head) => {
    if (rejectNextStatus !== null) {
      const status = rejectNextStatus
      rejectNextStatus = null
      socket.once("error", () => undefined)
      socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
      request.resume()
      return
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request))
  })
  wss.on("connection", socket => {
    let resolveClosed: () => void = () => undefined
    const closed = new Promise<void>(resolve => {
      resolveClosed = resolve
    })
    const connection: FakeConnection = { socket, texts: [], binaries: [], closed }
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        connection.binaries.push(Buffer.from(data as Buffer))
      } else {
        connection.texts.push(data.toString())
      }
    })
    socket.on("close", () => resolveClosed())
    connections.push(connection)
    onConnection?.(connection)
  })
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve))
  upstreamPort = (httpServer.address() as AddressInfo).port
  process.env.DEEPGRAM_WS_URL = `ws://127.0.0.1:${upstreamPort}/v1/listen`
}

// ── Fake client socket (same pattern as ws.voice.session.test.ts) ─────────

type Listener = (...args: unknown[]) => void

class FakeWebSocket {
  readyState = 1
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
  text?: string
  latencyMs?: number
  message?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out")
    }
    await flush()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function parsed(ws: FakeWebSocket): ParsedMessage[] {
  return ws.sent.map(raw => JSON.parse(raw) as ParsedMessage)
}

function voiceErrors(ws: FakeWebSocket): ParsedMessage[] {
  return parsed(ws).filter(m => m.type === "voice_error")
}

async function makeHandler(): Promise<{
  handler: InstanceType<HandlerModule["AgentWsHandler"]>
  ws: FakeWebSocket
}> {
  const ws = new FakeWebSocket()
  const handler = new AgentWsHandler(ws as unknown as WebSocket)
  ws.emit("message", JSON.stringify({ type: "auth", token: "test-token" }))
  await flush()
  return { handler, ws }
}

async function startVoice(ws: FakeWebSocket, sessionId = "v1"): Promise<void> {
  ws.emit("message", JSON.stringify({ type: "voice_start", sessionId }))
  await flush()
}

function sendAudio(ws: FakeWebSocket, byteLength: number): void {
  ws.emit("message", Buffer.alloc(byteLength, 7), true)
}

/** Respond to Finalize with a flushed final transcript. */
function respondWithFinal(connection: FakeConnection, text: string): void {
  connection.socket.on("message", (data, isBinary) => {
    if (!isBinary && data.toString().includes('"Finalize"')) {
      connection.socket.send(
        JSON.stringify({
          type: "Results",
          is_final: true,
          from_finalize: true,
          channel: { alternatives: [{ transcript: text }] },
        })
      )
    }
  })
}

// ── Suite ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await startFakeUpstream()
  const handlerModule = require("../websocket/agent.ws.handler") as HandlerModule
  AgentWsHandler = handlerModule.AgentWsHandler
  closeAllVoiceUpstreams = (require("../services/deepgram.stream") as StreamModule)
    .closeAllVoiceUpstreams
  const sttModule = require("../services/stt.service") as SttModule
  sttBreaker = sttModule.sttBreaker
})

afterAll(async () => {
  closeAllVoiceUpstreams()
  for (const connection of connections) {
    connection.socket.terminate()
  }
  await new Promise<void>(resolve => wss.close(() => resolve()))
  await new Promise<void>(resolve => httpServer.close(() => resolve()))
})

beforeEach(async () => {
  jest.clearAllMocks()
  mockRedisEval.mockReset()
  mockRedisEval.mockImplementation(async (): Promise<unknown> => [1, 1])
  mockSaveVoiceTranscript.mockImplementation(async (): Promise<null> => null)
  rejectNextStatus = null
  onConnection = null
  for (const connection of connections) {
    connection.socket.terminate()
  }
  connections = []
  sttBreaker.resetForTests()
  await flush()
})

describe("voice session + Deepgram upstream (Day 5)", () => {
  it("forwards audio and delivers one transcript_final + persist on voice_end", async () => {
    onConnection = connection => respondWithFinal(connection, "hello deepgram")
    const { handler, ws } = await makeHandler()
    await startVoice(ws)

    await waitFor(() => connections.length === 1)
    const connection = connections[0]
    expect(connection).toBeDefined()

    sendAudio(ws, 4_096)
    sendAudio(ws, 2_000)
    await waitFor(() => connection?.binaries.length === 2)
    expect(connection?.binaries[0]?.length).toBe(4_096)
    expect(connection?.binaries[1]?.length).toBe(2_000)

    ws.emit("message", JSON.stringify({ type: "voice_end", sessionId: "v1" }))
    await waitFor(() => parsed(ws).some(m => m.type === "transcript_final"))

    const finals = parsed(ws).filter(m => m.type === "transcript_final")
    expect(finals).toHaveLength(1)
    expect(finals[0]?.text).toBe("hello deepgram")
    expect(finals[0]?.latencyMs).toBeGreaterThanOrEqual(0)
    expect(finals[0]?.sessionId).toBe("v1")

    // Persist the final (text only — never raw audio).
    await waitFor(() => mockSaveVoiceTranscript.mock.calls.length === 1)
    expect(mockSaveVoiceTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-dg", sessionId: "v1", text: "hello deepgram" })
    )

    // Close path on voice_end: Finalize first, then CloseStream then close.
    await waitFor(() => connection?.texts.includes('{"type":"CloseStream"}') === true)
    const finalizeIndex = connection?.texts.findIndex(t => t.includes('"Finalize"')) ?? -1
    const closeIndex = connection?.texts.indexOf('{"type":"CloseStream"}') ?? -1
    expect(finalizeIndex).toBeGreaterThanOrEqual(0)
    expect(closeIndex).toBeGreaterThan(finalizeIndex)

    expect(voiceErrors(ws)).toHaveLength(0)
    expect(handler.getVoiceDiagnostics().utteranceOpen).toBe(false)
  })

  it("charges STT by bytes forwarded, converted to seconds (32 000 B/s)", async () => {
    const { ws } = await makeHandler()
    await startVoice(ws)
    await waitFor(() => connections.length === 1)

    // voice_start charged 1 unit already.
    expect(mockRedisEval).toHaveBeenCalledTimes(1)
    expect(mockRedisEval.mock.calls[0]?.[4]).toBe("1")

    // 7 × 4096 + 3328 = 32 000 B = exactly one whole second → +1 unit.
    for (let i = 0; i < 7; i++) {
      sendAudio(ws, 4_096)
    }
    sendAudio(ws, 3_328)
    await waitFor(() => connections[0]?.binaries.length === 8)

    await waitFor(() => mockRedisEval.mock.calls.length === 2)
    expect(mockRedisEval.mock.calls[1]?.[4]).toBe("1")
    // Byte-exact: one charge for one whole second, not per frame.
    expect(mockRedisEval).toHaveBeenCalledTimes(2)
    expect(voiceErrors(ws)).toHaveLength(0)
  })

  it("fails closed when the mid-utterance budget charge is refused", async () => {
    const { handler, ws } = await makeHandler()
    await startVoice(ws)
    await waitFor(() => connections.length === 1)
    const connection = connections[0]

    // voice_start already charged (fallback allowed). The NEXT eval — the
    // first per-second charge — is refused.
    mockRedisEval.mockImplementationOnce(async (): Promise<unknown> => [-1, -1])

    // 8 × 4096 B = 32 768 B ≥ one whole second → the per-second charge
    // fires on the 8th frame and is refused.
    for (let i = 0; i < 8; i++) {
      sendAudio(ws, 4_096)
    }
    await waitFor(() => voiceErrors(ws).length > 0)

    expect(voiceErrors(ws)[0]).toMatchObject({ code: "VOICE_CAPACITY_REACHED" })
    // Upstream closed (CloseStream then close) and the utterance is over.
    await waitFor(() => connection?.texts.includes('{"type":"CloseStream"}') === true)
    expect(handler.getVoiceDiagnostics().utteranceOpen).toBe(false)

    // Further audio is refused outright — nothing more reaches the provider.
    const binariesBefore = connection?.binaries.length ?? 0
    sendAudio(ws, 100)
    await flush()
    await flush()
    expect(connection?.binaries.length).toBe(binariesBefore)
  })

  it("402 opens the breaker as VOICE_BUDGET_REACHED; next start fails fast", async () => {
    rejectNextStatus = 402
    const { ws } = await makeHandler()
    await startVoice(ws)

    await waitFor(() => voiceErrors(ws).length > 0)
    expect(voiceErrors(ws)[0]).toMatchObject({ code: "VOICE_BUDGET_REACHED" })
    expect(sttBreaker.state).toBe("open")
    expect(sttBreaker.consecutiveFailures).toBe(5) // tripped, not counted

    // Fail fast: no new upstream connection, PROVIDER_UNAVAILABLE on the wire.
    const connectionsBefore = connections.length
    await startVoice(ws, "v2")
    await waitFor(() => voiceErrors(ws).length > 1)
    expect(voiceErrors(ws)[1]).toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
    expect(connections.length).toBe(connectionsBefore)
  })

  it("takeover: the second connection closes the old upstream (one per user)", async () => {
    const first = await makeHandler()
    await startVoice(first.ws, "v1")
    await waitFor(() => connections.length === 1)

    const second = await makeHandler()
    await startVoice(second.ws, "v2")
    await waitFor(() => connections.length === 2)

    // Old upstream sees CloseStream then close; old client is told to stop.
    const oldConnection = connections[0]
    await waitFor(() => oldConnection?.texts.includes('{"type":"CloseStream"}') === true)
    await oldConnection?.closed
    await waitFor(() => voiceErrors(first.ws).length > 0)
    expect(voiceErrors(first.ws)[0]).toMatchObject({ code: "NO_VOICE_SESSION" })

    // New connection owns the slot.
    expect(voiceErrors(second.ws)).toHaveLength(0)
    sendAudio(second.ws, 1_000)
    await waitFor(() => connections[1]?.binaries.length === 1)
  })

  it("client close sends CloseStream to the upstream", async () => {
    const { ws } = await makeHandler()
    await startVoice(ws)
    await waitFor(() => connections.length === 1)
    const connection = connections[0]

    ws.emit("close", 1000, Buffer.alloc(0))
    await waitFor(() => connection?.texts.includes('{"type":"CloseStream"}') === true)
    await connection?.closed
    expect(voiceErrors(ws)).toHaveLength(0) // deliberate close is not a failure
  })

  it("mid-utterance drop surfaces STT_FAILED and stops the utterance", async () => {
    const { ws } = await makeHandler()
    await startVoice(ws)
    await waitFor(() => connections.length === 1)
    const connection = connections[0]

    sendAudio(ws, 1_600)
    await waitFor(() => connection?.binaries.length === 1)

    connection?.socket.close(1011, "provider went away")
    await waitFor(() => voiceErrors(ws).length > 0)
    expect(voiceErrors(ws)[0]).toMatchObject({ code: "STT_FAILED" })

    // Utterance over: further frames are refused, nothing forwarded.
    const binariesBefore = connection?.binaries.length ?? 0
    sendAudio(ws, 100)
    await flush()
    await flush()
    expect(connection?.binaries.length).toBe(binariesBefore)
    expect(voiceErrors(ws).some(m => m.code === "NO_VOICE_SESSION")).toBe(true)
  })

  it("session cap closes the upstream (CloseStream then close)", async () => {
    const { ws } = await makeHandler()
    await startVoice(ws)
    await waitFor(() => connections.length === 1)
    const connection = connections[0]

    // Jump past the 10-minute session cap for the next frame.
    const realNow = Date.now
    const spy = jest.spyOn(Date, "now").mockReturnValue(realNow() + 11 * 60_000)
    try {
      sendAudio(ws, 32)
      await flush()
      await flush()
    } finally {
      spy.mockRestore()
    }

    expect(voiceErrors(ws)[0]).toMatchObject({ code: "SESSION_LIMIT" })
    await waitFor(() => connection?.texts.includes('{"type":"CloseStream"}') === true)
  })

  it("shutdown closes every live upstream (CloseStream then close)", async () => {
    const { ws } = await makeHandler()
    await startVoice(ws)
    await waitFor(() => connections.length === 1)
    const connection = connections[0]

    closeAllVoiceUpstreams()
    await waitFor(() => connection?.texts.includes('{"type":"CloseStream"}') === true)
    await connection?.closed
    expect(voiceErrors(ws)).toHaveLength(0)
  })
})
