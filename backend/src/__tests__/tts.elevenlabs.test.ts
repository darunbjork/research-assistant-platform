// backend/src/__tests__/tts.elevenlabs.test.ts
//
// ElevenLabs streaming TTS client, tested against a mocked fetch — the real
// ElevenLabs API is never called. Covers the request shape, even-length
// re-chunking, error mapping, abort and the circuit breaker.

import {
  ElevenLabsTtsService,
  MockTtsService,
  TtsError,
  TTS_MAX_CHUNK_BYTES,
  evenChunks,
  withTtsBreaker,
} from "../services/tts.service"
import { RateLimitError } from "../middleware/error.middleware"
import { CircuitBreaker, CircuitOpenError } from "../utils/circuit-breaker"

const CONFIG = {
  apiKey: "el-test-key-0123456789",
  voiceId: "voice/id 1",
  modelId: "eleven_flash_v2_5",
  outputFormat: "pcm_24000",
  baseUrl: "https://tts.example.test",
}
const REQUEST = { text: "Hello there.", sessionId: "session-1" }

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** A streaming body that hands out `pieces` one per pull and records reads. */
function streamingBody(pieces: Uint8Array[]): {
  body: ReadableStream<Uint8Array>
  pulls: () => number
  cancelled: () => boolean
} {
  let index = 0
  let pullCount = 0
  let wasCancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        pullCount += 1
        const piece = pieces[index++]
        if (piece === undefined) controller.close()
        else controller.enqueue(piece)
      },
      cancel(): void {
        wasCancelled = true
      },
    },
    { highWaterMark: 0 }
  )
  return { body, pulls: () => pullCount, cancelled: () => wasCancelled }
}

function bytes(length: number, fill = 1): Uint8Array {
  return new Uint8Array(length).fill(fill)
}

describe("ElevenLabsTtsService", () => {
  let fetchSpy: jest.SpyInstance
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected request"))
  })
  afterEach(() => jest.restoreAllMocks())

  it("POSTs the text to the streaming endpoint with the key header and model", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(streamingBody([bytes(4)]).body))
    const service = new ElevenLabsTtsService(CONFIG)
    await collect(service.synthesizeStream(REQUEST, new AbortController().signal))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      "https://tts.example.test/v1/text-to-speech/voice%2Fid%201/stream?output_format=pcm_24000"
    )
    expect(init.method).toBe("POST")
    const headers = init.headers as Record<string, string>
    expect(headers["xi-api-key"]).toBe(CONFIG.apiKey)
    expect(headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Hello there.",
      model_id: "eleven_flash_v2_5",
    })
  })

  it("re-chunks odd-length upstream pieces into even chunks of at most 8 KB", async () => {
    const upstream = [bytes(3), bytes(5), bytes(20_001), bytes(1), bytes(2)]
    fetchSpy.mockResolvedValueOnce(new Response(streamingBody(upstream).body))
    const chunks = await collect(
      new ElevenLabsTtsService(CONFIG).synthesizeStream(REQUEST, new AbortController().signal)
    )

    const total = upstream.reduce((sum, piece) => sum + piece.length, 0) // 20 012
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length % 2).toBe(0)
      expect(chunk.length).toBeLessThanOrEqual(TTS_MAX_CHUNK_BYTES)
      expect(chunk.length).toBeGreaterThan(0)
    }
    expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(total)
  })

  it("drops a final odd byte instead of emitting half a sample", async () => {
    const chunks = await collect(
      evenChunks(
        (async function* (): AsyncIterable<Uint8Array> {
          yield bytes(3)
          yield bytes(2)
        })()
      )
    )
    expect(chunks.map(chunk => chunk.length)).toEqual([2, 2])
  })

  it.each([
    [401, "", "TTS_AUTH"],
    [403, "", "TTS_AUTH"],
    [402, "", "TTS_QUOTA"],
    [401, '{"detail":{"status":"quota_exceeded"}}', "TTS_QUOTA"],
    [500, "", "TTS_UNAVAILABLE"],
    [503, "", "TTS_UNAVAILABLE"],
    [400, "", "TTS_FAILED"],
  ])("maps HTTP %i %s to %s", async (status, body, code) => {
    fetchSpy.mockResolvedValueOnce(new Response(body, { status }))
    const stream = new ElevenLabsTtsService(CONFIG).synthesizeStream(
      REQUEST,
      new AbortController().signal
    )
    await expect(collect(stream)).rejects.toMatchObject({ name: "TtsError", code, status })
  })

  it("maps a library voice on a free plan (402 paid_plan_required) to TTS_FAILED, not quota", async () => {
    const body = JSON.stringify({
      detail: {
        type: "payment_required",
        code: "paid_plan_required",
        message: "Free users cannot use library voices via the API.",
        status: "payment_required",
      },
    })
    fetchSpy.mockResolvedValueOnce(new Response(body, { status: 402 }))
    const stream = new ElevenLabsTtsService(CONFIG).synthesizeStream(
      REQUEST,
      new AbortController().signal
    )
    const error = (await collect(stream).catch((caught: unknown) => caught)) as TtsError
    expect(error.code).toBe("TTS_FAILED")
    expect(error.providerCode).toBe("paid_plan_required")
    expect(error.message).toContain("paid ElevenLabs plan")
  })

  it("keeps ElevenLabs' quota_exceeded code on the quota error", async () => {
    const body = JSON.stringify({ detail: { code: "quota_exceeded", status: "quota_exceeded" } })
    fetchSpy.mockResolvedValueOnce(new Response(body, { status: 401 }))
    const stream = new ElevenLabsTtsService(CONFIG).synthesizeStream(
      REQUEST,
      new AbortController().signal
    )
    await expect(collect(stream)).rejects.toMatchObject({
      code: "TTS_QUOTA",
      providerCode: "quota_exceeded",
    })
  })

  it("maps 429 to RateLimitError", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 429 }))
    const stream = new ElevenLabsTtsService(CONFIG).synthesizeStream(
      REQUEST,
      new AbortController().signal
    )
    await expect(collect(stream)).rejects.toBeInstanceOf(RateLimitError)
  })

  it("maps a network failure to TTS_UNAVAILABLE", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"))
    const stream = new ElevenLabsTtsService(CONFIG).synthesizeStream(
      REQUEST,
      new AbortController().signal
    )
    await expect(collect(stream)).rejects.toMatchObject({ code: "TTS_UNAVAILABLE" })
  })

  it("gives up with TTS_UNAVAILABLE when no audio arrives within the first-byte timeout", async () => {
    fetchSpy.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          )
        })
    )
    const service = new ElevenLabsTtsService({ ...CONFIG, firstByteTimeoutMs: 20 })
    const error = (await collect(
      service.synthesizeStream(REQUEST, new AbortController().signal)
    ).catch((caught: unknown) => caught)) as TtsError
    expect(error.code).toBe("TTS_UNAVAILABLE")
    expect(error.message).toContain("first-byte")
  })

  it("stops reading from ElevenLabs as soon as the caller aborts", async () => {
    const upstream = streamingBody([bytes(4), bytes(4), bytes(4), bytes(4)])
    fetchSpy.mockResolvedValueOnce(new Response(upstream.body))
    const controller = new AbortController()
    const received: Buffer[] = []

    for await (const chunk of new ElevenLabsTtsService(CONFIG).synthesizeStream(
      REQUEST,
      controller.signal
    )) {
      received.push(chunk)
      controller.abort()
    }

    const pullsAfterAbort = upstream.pulls()
    expect(received).toHaveLength(1)
    expect(upstream.cancelled()).toBe(true)
    expect(pullsAfterAbort).toBeLessThanOrEqual(2)
  })

  it("never puts the text or the key in an error message", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 500 }))
    const stream = new ElevenLabsTtsService(CONFIG).synthesizeStream(
      { text: "secret answer text", sessionId: "s" },
      new AbortController().signal
    )
    const error = (await collect(stream).catch((caught: unknown) => caught)) as Error
    expect(error.message).not.toContain("secret answer text")
    expect(error.message).not.toContain(CONFIG.apiKey)
  })
})

describe("withTtsBreaker", () => {
  let fetchSpy: jest.SpyInstance
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected request"))
  })
  afterEach(() => jest.restoreAllMocks())

  function guarded(threshold = 2): {
    service: ReturnType<typeof withTtsBreaker>
    breaker: CircuitBreaker
  } {
    const breaker = new CircuitBreaker("tts-test", {
      failureThreshold: threshold,
      cooldownMs: 60_000,
    })
    return { service: withTtsBreaker(new ElevenLabsTtsService(CONFIG), breaker), breaker }
  }
  const run = (service: ReturnType<typeof withTtsBreaker>): Promise<Buffer[]> =>
    collect(service.synthesizeStream(REQUEST, new AbortController().signal))

  it("opens after repeated outages and then refuses without calling ElevenLabs", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response("", { status: 503 })))
    const { service, breaker } = guarded(2)

    await expect(run(service)).rejects.toBeInstanceOf(TtsError)
    await expect(run(service)).rejects.toBeInstanceOf(TtsError)
    expect(breaker.state).toBe("open")

    await expect(run(service)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("trips open immediately on a quota response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 402 }))
    const { service, breaker } = guarded(5)
    await expect(run(service)).rejects.toMatchObject({ code: "TTS_QUOTA" })
    expect(breaker.state).toBe("open")
  })

  it("does not open the breaker for a paid-voice setup error", async () => {
    const body = JSON.stringify({ detail: { code: "paid_plan_required" } })
    fetchSpy.mockResolvedValueOnce(new Response(body, { status: 402 }))
    const { service, breaker } = guarded(1)
    await expect(run(service)).rejects.toMatchObject({ code: "TTS_FAILED" })
    expect(breaker.state).toBe("closed")
  })

  it("does not count auth or rate-limit errors as outages", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
    const { service, breaker } = guarded(1)
    await expect(run(service)).rejects.toMatchObject({ code: "TTS_AUTH" })
    await expect(run(service)).rejects.toBeInstanceOf(RateLimitError)
    expect(breaker.state).toBe("closed")
  })

  it("resets the failure count after a successful stream", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(streamingBody([bytes(2)]).body))
    const { service, breaker } = guarded(2)
    await expect(run(service)).rejects.toBeInstanceOf(TtsError)
    expect(breaker.consecutiveFailures).toBe(1)
    await run(service)
    expect(breaker.consecutiveFailures).toBe(0)
  })
})

describe("MockTtsService.synthesizeStream", () => {
  it("streams silence in 4 KB chunks totalling 10 ms per character", async () => {
    const chunks = await collect(
      new MockTtsService().synthesizeStream(
        { text: "a".repeat(100), sessionId: "s" },
        new AbortController().signal
      )
    )
    // 1000 ms × 24 000 samples/s × 2 bytes = 48 000 bytes
    expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(48_000)
    expect(chunks.every(chunk => chunk.length <= 4096 && chunk.length % 2 === 0)).toBe(true)
    expect(chunks.every(chunk => chunk.every(byte => byte === 0))).toBe(true)
  })

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController()
    const received: Buffer[] = []
    for await (const chunk of new MockTtsService().synthesizeStream(
      { text: "a".repeat(100), sessionId: "s" },
      controller.signal
    )) {
      received.push(chunk)
      controller.abort()
    }
    expect(received).toHaveLength(1)
  })
})
