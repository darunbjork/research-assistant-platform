// backend/src/__tests__/deepgram.stream.test.ts
//
// Day 5: Deepgram streaming client against a LOCAL fake WebSocket server —
// no real network, no real key, no billing (VOICE_MOCK verification).
// Covers the Darun requirement list:
//   - Authorization header carries the key (Token scheme), URL pins the
//     audio contract (docs cited in deepgram.stream.ts)
//   - close path: CloseStream then close (deliberate close())
//   - handshake classification: 401/429 ignore, 402 quota, 5xx/network count
//   - error frame → non-fatal (surfaced, NOT counted)
//   - mid-utterance drop → counted
//   - Finalize timeout with no final → counted; empty flush → silent null
//   - stall/backpressure → buffer cap fails closed (counted)
//   - KeepAlive as a TEXT frame during silence only
//   - interim results are never delivered

import { WebSocketServer, type WebSocket as ServerSocket } from "ws"
import { createServer, type Server as HttpServer } from "http"
import type { AddressInfo } from "net"
import {
  DeepgramStream,
  DeepgramHandshakeError,
  buildListenUrl,
  classifyHandshakeStatus,
  registerUpstream,
  unregisterUpstream,
  closeAllVoiceUpstreams,
  type DeepgramStreamFailure,
} from "../services/deepgram.stream"

const activeCleanups: Array<() => Promise<void>> = []

interface FakeUpstream {
  url: string
  server: WebSocketServer
  /** Resolves with the first client connection (socket + raw request). */
  connection: Promise<{
    socket: ServerSocket
    headers: Record<string, string | undefined>
    url: string
  }>
  /** Text frames received, in order. */
  texts: string[]
  /** Binary frames received, in order. */
  binaries: Buffer[]
  /** True once the client's socket closed. */
  closed: Promise<void>
  close: () => Promise<void>
}

async function startFakeUpstream(
  onConnection?: (socket: ServerSocket) => void
): Promise<FakeUpstream> {
  const texts: string[] = []
  const binaries: Buffer[] = []
  let resolveConnection: (value: {
    socket: ServerSocket
    headers: Record<string, string | undefined>
    url: string
  }) => void = () => undefined
  let resolveClosed: () => void = () => undefined
  const connection = new Promise<{
    socket: ServerSocket
    headers: Record<string, string | undefined>
    url: string
  }>(resolve => {
    resolveConnection = resolve
  })
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve
  })

  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>(resolve => server.once("listening", resolve))
  const port = (server.address() as AddressInfo).port

  server.on("connection", (socket, request) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        binaries.push(Buffer.from(data as Buffer))
      } else {
        texts.push(data.toString())
      }
    })
    socket.on("close", () => resolveClosed())
    resolveConnection({
      socket,
      headers: request.headers as Record<string, string | undefined>,
      url: request.url ?? "",
    })
    onConnection?.(socket)
  })

  const cleanup = async (): Promise<void> => {
    for (const client of server.clients) {
      client.terminate()
    }
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  activeCleanups.push(cleanup)

  return {
    url: `ws://127.0.0.1:${port}`,
    server,
    connection,
    texts,
    binaries,
    closed,
    close: cleanup,
  }
}

/** Raw HTTP rejection server (401/402/429/500 handshakes). */
async function startRejectingUpstream(status: number): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const httpServer: HttpServer = createServer((_req, res) => {
    res.writeHead(status).end()
  })
  httpServer.on("upgrade", (request, socket) => {
    socket.once("error", () => undefined)
    socket.write(`HTTP/1.1 ${status} Test\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
    request.resume()
  })
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve))
  const port = (httpServer.address() as AddressInfo).port
  const cleanup = async (): Promise<void> => {
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
  }
  activeCleanups.push(cleanup)
  return {
    url: `ws://127.0.0.1:${port}`,
    close: cleanup,
  }
}

interface StreamHarness {
  stream: DeepgramStream
  finals: Array<{ text: string; fromFinalize: boolean }>
  failures: DeepgramStreamFailure[]
  /** Resolves when the next failure is reported. */
  nextFailure: () => Promise<DeepgramStreamFailure>
}

function makeStream(
  url: string,
  overrides: Partial<ConstructorParameters<typeof DeepgramStream>[0]> = {}
): StreamHarness {
  const finals: Array<{ text: string; fromFinalize: boolean }> = []
  const failures: DeepgramStreamFailure[] = []
  const pending: Array<(failure: DeepgramStreamFailure) => void> = []
  const stream = new DeepgramStream({
    url,
    apiKey: "dg-test-key-0123456789",
    sessionId: "sess-test",
    onFinal: (text, fromFinalize) => finals.push({ text, fromFinalize }),
    onFailure: failure => {
      failures.push(failure)
      pending.splice(0).forEach(resolve => resolve(failure))
    },
    keepAliveMs: 40,
    keepAliveQuietMs: 30,
    finalizeTimeoutMs: 150,
    handshakeTimeoutMs: 2_000,
    ...overrides,
  })
  return {
    stream,
    finals,
    failures,
    nextFailure: () =>
      new Promise<DeepgramStreamFailure>(resolve => {
        const last = failures[failures.length - 1]
        if (last !== undefined) {
          resolve(last)
          return
        }
        pending.push(resolve)
      }),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out")
    }
    await sleep(10)
  }
}

afterEach(async () => {
  closeAllVoiceUpstreams()
  while (activeCleanups.length > 0) {
    const cleanup = activeCleanups.pop()
    if (cleanup !== undefined) {
      await cleanup().catch(() => undefined)
    }
  }
})

describe("buildListenUrl", () => {
  it("pins the audio contract from the Deepgram docs", () => {
    const url = new URL(buildListenUrl("wss://api.deepgram.com/v1/listen", "nova-3"))
    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.get("encoding")).toBe("linear16")
    expect(url.searchParams.get("sample_rate")).toBe("16000")
    expect(url.searchParams.get("channels")).toBe("1")
    expect(url.searchParams.get("model")).toBe("nova-3")
    // Finals only — interim transcripts must never exist on the wire.
    expect(url.searchParams.get("interim_results")).toBe("false")
    expect(url.searchParams.get("smart_format")).toBe("true")
  })

  it("accepts an overridable local base URL for the fake-server tests", () => {
    const url = buildListenUrl("ws://127.0.0.1:9999/v1/listen", "nova-2")
    expect(url).toContain("ws://127.0.0.1:9999/v1/listen")
    expect(new URL(url).searchParams.get("model")).toBe("nova-2")
  })
})

describe("classifyHandshakeStatus", () => {
  it("classifies 402 as quota, other 4xx as ignore, 5xx/network as count", () => {
    expect(classifyHandshakeStatus(402)).toBe("quota")
    expect(classifyHandshakeStatus(401)).toBe("ignore")
    expect(classifyHandshakeStatus(429)).toBe("ignore")
    expect(classifyHandshakeStatus(400)).toBe("ignore")
    expect(classifyHandshakeStatus(500)).toBe("count")
    expect(classifyHandshakeStatus(503)).toBe("count")
    expect(classifyHandshakeStatus(null)).toBe("count")
  })
})

describe("DeepgramStream handshake", () => {
  it("sends the key in an Authorization: Token header and connects", async () => {
    const upstream = await startFakeUpstream()
    const harness = makeStream(buildListenUrl(upstream.url, "nova-3"))
    await harness.stream.connect()
    const { headers, url } = await upstream.connection
    expect(headers.authorization).toBe("Token dg-test-key-0123456789")
    expect(url).toContain("encoding=linear16")
    expect(url).toContain("model=nova-3")
    expect(harness.stream.isOpen).toBe(true)
    harness.stream.close()
    await upstream.close()
  })

  it("rejects with the HTTP status on 401/402/429/500", async () => {
    for (const status of [401, 402, 429, 500]) {
      const upstream = await startRejectingUpstream(status)
      const harness = makeStream(buildListenUrl(upstream.url, "nova-3"))
      let caught: unknown = null
      try {
        await harness.stream.connect()
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DeepgramHandshakeError)
      expect((caught as DeepgramHandshakeError).status).toBe(status)
      await upstream.close()
    }
  })

  it("rejects (count-classifiable, status null) when nothing listens", async () => {
    const harness = makeStream("ws://127.0.0.1:1/v1/listen")
    let caught: unknown = null
    try {
      await harness.stream.connect()
    } catch (error: unknown) {
      caught = error
    }
    // Not an HTTP-status rejection (Node's ECONNREFUSED error comes from the
    // host realm, so no instanceof check — assert on shape instead).
    expect(caught).not.toBeInstanceOf(DeepgramHandshakeError)
    expect(String(caught)).toContain("ECONNREFUSED")
    expect(classifyHandshakeStatus(null)).toBe("count")
  })
})

describe("DeepgramStream audio and finals", () => {
  it("forwards binary audio and delivers exactly one final after Finalize", async () => {
    const upstream = await startFakeUpstream(socket => {
      socket.on("message", (data, isBinary) => {
        if (!isBinary && data.toString().includes("Finalize")) {
          socket.send(
            JSON.stringify({
              type: "Results",
              is_final: true,
              from_finalize: true,
              channel: { alternatives: [{ transcript: "hello world" }] },
            })
          )
        }
      })
    })
    const harness = makeStream(buildListenUrl(upstream.url, "nova-3"))
    await harness.stream.connect()
    const { socket } = await upstream.connection

    const frame = Buffer.alloc(3_200, 1)
    expect(harness.stream.sendAudio(frame)).toBe(true)
    await waitFor(() => upstream.binaries.length === 1)
    expect(upstream.binaries[0]?.equals(frame)).toBe(true)

    // An interim arriving uninvited must NOT be delivered (never logged).
    socket.send(
      JSON.stringify({
        type: "Results",
        is_final: false,
        channel: { alternatives: [{ transcript: "interim should vanish" }] },
      })
    )
    await sleep(30)
    expect(harness.finals).toHaveLength(0)

    await harness.stream.finalize()
    await waitFor(() => harness.finals.length === 1)
    expect(harness.finals[0]).toEqual({ text: "hello world", fromFinalize: true })
    expect(harness.failures).toHaveLength(0)

    harness.stream.close()
    await upstream.close()
  })

  it("resolves finalize with null on an empty flush — silence is not a failure", async () => {
    const upstream = await startFakeUpstream(socket => {
      socket.on("message", (data, isBinary) => {
        if (!isBinary && data.toString().includes("Finalize")) {
          socket.send(
            JSON.stringify({
              type: "Results",
              is_final: true,
              from_finalize: true,
              channel: { alternatives: [{ transcript: "" }] },
            })
          )
        }
      })
    })
    const harness = makeStream(buildListenUrl(upstream.url, "nova-3"))
    await harness.stream.connect()
    await upstream.connection

    await expect(harness.stream.finalize()).resolves.toBeNull()
    expect(harness.finals).toHaveLength(0)
    expect(harness.failures).toHaveLength(0)

    harness.stream.close()
    await upstream.close()
  })

  it("Finalize timeout with NO final is counted; with a prior final it delivers", async () => {
    // (a) nothing at all → counted failure
    const silent = await startFakeUpstream(socket => {
      socket.on("message", () => {
        // Consume Finalize, respond with nothing.
      })
    })
    const a = makeStream(buildListenUrl(silent.url, "nova-3"), { finalizeTimeoutMs: 80 })
    await a.stream.connect()
    await silent.connection
    await expect(a.stream.finalize()).resolves.toBeNull()
    expect(a.failures).toHaveLength(1)
    expect(a.failures[0]?.action).toBe("count")
    expect(a.failures[0]?.message).toContain("No final transcript after Finalize")
    expect(a.finals).toHaveLength(0)
    a.stream.close()
    await silent.close()

    // (b) a final arrived before Finalize → delivered, no failure
    const prior = await startFakeUpstream(socket => {
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            type: "Results",
            is_final: true,
            from_finalize: false,
            channel: { alternatives: [{ transcript: "prior final" }] },
          })
        )
      }, 10)
    })
    const b = makeStream(buildListenUrl(prior.url, "nova-3"), { finalizeTimeoutMs: 120 })
    await b.stream.connect()
    await prior.connection
    await b.stream.finalize()
    await waitFor(() => b.finals.length === 1)
    expect(b.finals[0]?.text).toBe("prior final")
    expect(b.failures).toHaveLength(0)
    b.stream.close()
    await prior.close()
  })
})

describe("DeepgramStream failure paths", () => {
  it("mid-utterance drop (server closes) is counted", async () => {
    const upstream = await startFakeUpstream()
    const harness = makeStream(buildListenUrl(upstream.url, "nova-3"))
    await harness.stream.connect()
    const { socket } = await upstream.connection
    harness.stream.sendAudio(Buffer.alloc(1_600, 2))

    socket.close(1011, "provider went away")
    const failure = await harness.nextFailure()
    expect(failure.action).toBe("count")
    expect(failure.message).toContain("closed the stream unexpectedly")
    expect(harness.stream.isOpen).toBe(false)
    await upstream.close()
  })

  it("an Error frame is surfaced but NOT counted (non-fatal per docs)", async () => {
    const upstream = await startFakeUpstream(socket => {
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            type: "Error",
            variant: "SchemaError",
            description: "Unrecognized request",
          })
        )
      }, 10)
    })
    const harness = makeStream(buildListenUrl(upstream.url, "nova-3"))
    await harness.stream.connect()
    await upstream.connection

    const failure = await harness.nextFailure()
    expect(failure.action).toBe("ignore")
    expect(failure.message).toContain("SchemaError")
    expect(harness.failures).toHaveLength(1)
    // The stream closes itself after surfacing the error.
    await waitFor(() => !harness.stream.isOpen)
    await upstream.close()
  })

  it("backpressure past the buffer cap fails closed (counted) and closes", async () => {
    const upstream = await startFakeUpstream()
    let buffered = 0
    const harness = makeStream(buildListenUrl(upstream.url, "nova-3"), {
      bufferCapBytes: 8_192,
      getBufferedAmount: () => buffered,
    })
    await harness.stream.connect()
    await upstream.connection

    buffered = 8_192 // exactly at the cap → still allowed
    expect(harness.stream.sendAudio(Buffer.alloc(1_600, 3))).toBe(true)
    await waitFor(() => upstream.binaries.length === 1)

    buffered = 8_193 // one byte over → refuse, report, close
    expect(harness.stream.sendAudio(Buffer.alloc(1_600, 4))).toBe(false)
    const failure = await harness.nextFailure()
    expect(failure.action).toBe("count")
    expect(failure.message).toContain("backpressure")
    expect(harness.stream.isOpen).toBe(false)

    // Frames after the refusal are silently dropped (no second failure).
    expect(harness.stream.sendAudio(Buffer.alloc(100, 5))).toBe(false)
    expect(harness.failures).toHaveLength(1)
    await upstream.close()
  })

  it("close() sends CloseStream as a text frame, then closes", async () => {
    const upstream = await startFakeUpstream()
    const harness = makeStream(buildListenUrl(upstream.url, "nova-3"))
    await harness.stream.connect()
    await upstream.connection

    harness.stream.close()
    await upstream.closed
    expect(upstream.texts).toContain('{"type":"CloseStream"}')
    expect(harness.failures).toHaveLength(0) // deliberate close is not a failure
    harness.stream.close() // idempotent
    await upstream.close()
  })
})

describe("DeepgramStream keep-alive", () => {
  it("sends KeepAlive as a TEXT frame during silence only", async () => {
    const upstream = await startFakeUpstream()
    const harness = makeStream(buildListenUrl(upstream.url, "nova-3"), {
      keepAliveMs: 25,
      keepAliveQuietMs: 60,
    })
    await harness.stream.connect()
    await upstream.connection

    // Fresh audio → no keep-alive yet.
    harness.stream.sendAudio(Buffer.alloc(1_600, 6))
    await sleep(35)
    expect(upstream.texts).not.toContain('{"type":"KeepAlive"}')

    // Silence beyond the quiet window → keep-alive arrives (as TEXT).
    await waitFor(() => upstream.texts.includes('{"type":"KeepAlive"}'))
    harness.stream.close()
    await upstream.close()
  })
})

describe("per-user upstream registry (takeover)", () => {
  it("displaces the previous registration for the same user", () => {
    const closed: string[] = []
    const first = {
      stream: { close: () => closed.push("first") } as unknown as DeepgramStream,
      superseded: () => closed.push("first-superseded"),
    }
    const second = {
      stream: { close: () => closed.push("second") } as unknown as DeepgramStream,
      superseded: () => closed.push("second-superseded"),
    }

    expect(registerUpstream("user-1", first)).toBeNull()
    const displaced = registerUpstream("user-1", second)
    expect(displaced).toBe(first)

    // The caller closes the displaced stream and notifies its owner.
    displaced?.stream.close()
    displaced?.superseded()
    expect(closed).toEqual(["first", "first-superseded"])

    // Guarded delete: unregistering an old stream must not drop the new one.
    unregisterUpstream("user-1", first.stream)
    expect(registerUpstream("user-1", second)).toBe(second)
    unregisterUpstream("user-1", second.stream)
    expect(registerUpstream("user-1", second)).toBeNull()
  })
})
