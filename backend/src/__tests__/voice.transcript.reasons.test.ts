// backend/src/__tests__/voice.transcript.reasons.test.ts
process.env.VOICE_MOCK = "false"
process.env.DEEPGRAM_API_KEY = "dg-handler-key-0123456789"
process.env.ELEVENLABS_API_KEY = "el-handler-key-0123456789"
process.env.ELEVENLABS_VOICE_ID = "voice-id-test"

import type WebSocket from "ws"

interface FakePipeline {
  incr: () => FakePipeline
  incrby: () => FakePipeline
  expire: () => FakePipeline
  ttl: () => FakePipeline
  exec: () => Promise<unknown>
}
const mockRedisEval = jest.fn<Promise<unknown>, unknown[]>(async (): Promise<unknown> => [1, 1])
jest.mock("../utils/redis", () => ({
  redis: {
    multi: (): FakePipeline => {
      const p: FakePipeline = {
        incr: (): FakePipeline => p,
        incrby: (): FakePipeline => p,
        expire: (): FakePipeline => p,
        ttl: (): FakePipeline => p,
        exec: async (): Promise<unknown> => [[null, 1], [null, 1], [null, 60]],
      }
      return p
    },
    eval: mockRedisEval,
  },
  default: {},
}))
jest.mock("../utils/jwt.utils", () => ({
  verifyAccessToken: jest.fn(() => ({
    userId: "user-dg",
    email: "dg@test.local",
    role: "USER" as const,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
}))
jest.mock("../utils/prisma", () => ({
  prisma: { user: { findUnique: jest.fn(async () => ({ id: "user-dg" })) } },
}))
const mockStreamingRun = jest.fn(async (): Promise<void> => undefined)
jest.mock("../services/streaming.agent.service", () => ({
  StreamingAgentService: class { run = mockStreamingRun },
}))
const mockSaveVoiceTranscript = jest.fn(async (_input: unknown): Promise<null> => null)
jest.mock("../services/voice.transcript.service", () => ({
  saveVoiceTranscript: (input: unknown): Promise<null> => mockSaveVoiceTranscript(input),
  VOICE_TRANSCRIPT_RETENTION_DAYS: 30,
}))

type OnFinal = (text: string, meta: { reason: string }) => void
let capturedOnFinal: OnFinal | null = null

jest.mock("../services/deepgram.stream", () => {
  class DeepgramStream {
    isOpen = false
    connect = jest.fn(async () => { this.isOpen = true })
    finalize = jest.fn(async () => null)
    close = jest.fn(() => { this.isOpen = false })
    sendAudio = jest.fn(() => true)
    constructor(opts: { onFinal: OnFinal }) {
      capturedOnFinal = opts.onFinal
    }
  }
  const active = new Map<string, { stream: DeepgramStream; superseded: () => void }>()
  return {
    DeepgramStream,
    buildListenUrl: () => "ws://fake",
    classifyHandshakeStatus: () => "count",
    DeepgramHandshakeError: class extends Error { status: number | null = null },
    registerUpstream: (userId: string, reg: { stream: DeepgramStream; superseded: () => void }) => {
      const displaced = active.get(userId) ?? null
      active.set(userId, reg)
      return displaced
    },
    unregisterUpstream: (userId: string, stream: DeepgramStream) => {
      const cur = active.get(userId)
      if (cur?.stream === stream) active.delete(userId)
    },
    closeAllVoiceUpstreams: () => {
      for (const reg of active.values()) reg.stream.close()
      active.clear()
    },
  }
})
jest.mock("../services/stt.service", () => ({
  sttBreaker: {
    state: "closed",
    consecutiveFailures: 0,
    isAvailable: () => true,
    canAttempt: () => true,
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
    resetForTests: jest.fn(),
  },
}))

import { AgentWsHandler } from "../websocket/agent.ws.handler"
import { closeAllVoiceUpstreams } from "../services/deepgram.stream"

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
    for (const l of this.listeners.get(event) ?? []) l(...args)
  }
  send(data: string): void { this.sent.push(data) }
}
interface Msg { type: string; complete?: boolean; text?: string; code?: string; message?: string }
const flush = (): Promise<void> => new Promise(r => setImmediate(r))
const parsed = (ws: FakeWebSocket): Msg[] => ws.sent.map(s => JSON.parse(s) as Msg)

async function setup(): Promise<FakeWebSocket> {
  const ws = new FakeWebSocket()
  new AgentWsHandler(ws as unknown as WebSocket)
  ws.emit("message", JSON.stringify({ type: "auth", token: "t" }))
  await flush()
  ws.emit("message", JSON.stringify({ type: "voice_start", sessionId: "v1" }))
  await flush()
  return ws
}

describe("voice transcript_final reasons (Step 3)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    closeAllVoiceUpstreams()
    capturedOnFinal = null
    mockRedisEval.mockImplementation(async (): Promise<unknown> => [1, 1])
  })

  it("finalized: sends complete transcript_final and starts agent once", async () => {
    const ws = await setup()
    expect(capturedOnFinal).not.toBeNull()
    capturedOnFinal?.("hello", { reason: "finalized" })
    await flush(); await flush()

    const finals = parsed(ws).filter(m => m.type === "transcript_final")
    expect(finals).toEqual([expect.objectContaining({ text: "hello", complete: true, sessionId: "v1" })])
    expect(parsed(ws).filter(m => m.type === "voice_error")).toHaveLength(0)
    expect(mockStreamingRun).toHaveBeenCalledTimes(1)
    // voice_start turn(1) + voice-origin agent budget(5)
    expect(mockRedisEval.mock.calls.some(c => c[4] === "5")).toBe(true)
    expect(mockSaveVoiceTranscript).toHaveBeenCalled()
  })

  for (const reason of ["finalize_timeout", "connection_lost", "closed", "not_open"] as const) {
    it(`${reason}: sends transcript_final complete:false + TRANSCRIPT_INCOMPLETE, no agent`, async () => {
      const ws = await setup()
      capturedOnFinal?.("partial", { reason })
      await flush(); await flush()

      const finals = parsed(ws).filter(m => m.type === "transcript_final")
      expect(finals).toEqual([expect.objectContaining({ text: "partial", complete: false })])
      const errs = parsed(ws).filter(m => m.type === "voice_error")
      expect(errs).toEqual([expect.objectContaining({ code: "TRANSCRIPT_INCOMPLETE" })])
      expect(mockStreamingRun).not.toHaveBeenCalled()
      // only voice_start turn charged, no agent 5-unit charge
      expect(mockRedisEval).toHaveBeenCalledTimes(1)
    })
  }
})
