import { requestGemini, GeminiUnavailableError } from "../utils/gemini-request"
import { RateLimitError } from "../middleware/error.middleware"
import type { GeminiRequest } from "../types/llm.types"

const body: GeminiRequest = { contents: [{ parts: [{ text: "Question" }] }] }
const url = "https://example.test/generateContent"
function throttle(message = "Rate limit", retryAfter = "0"): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status: 429,
    headers: { "retry-after": retryAfter },
  })
}

describe("Gemini provider throttling", () => {
  let fetchSpy: jest.SpyInstance
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected request"))
  })
  afterEach(() => jest.restoreAllMocks())

  it("retries a temporary 429 and returns the successful response", async () => {
    fetchSpy
      .mockResolvedValueOnce(throttle())
      .mockResolvedValueOnce(new Response('{"candidates":[]}'))
    await expect(requestGemini(url, "key", body)).resolves.toEqual({ candidates: [] })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("stops after three throttled attempts with an actionable error", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(throttle()))
    await expect(requestGemini(url, "key", body)).rejects.toThrow(RateLimitError)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("does not retry exhausted daily quotas", async () => {
    fetchSpy.mockResolvedValueOnce(throttle("Quota exceeded: GenerateRequestsPerDay"))
    await expect(requestGemini(url, "key", body)).rejects.toThrow("quota is exhausted")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("shows the provider wait time instead of retrying before a long reset", async () => {
    fetchSpy.mockResolvedValueOnce(throttle("Rate limit", "45"))
    await expect(requestGemini(url, "key", body)).rejects.toThrow("45 seconds")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("cancels the retry wait when the client disconnects", async () => {
    const controller = new AbortController()
    fetchSpy.mockImplementation(() => {
      controller.abort()
      return Promise.resolve(throttle("Rate limit", "10"))
    })
    await expect(requestGemini(url, "key", body, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe("Gemini overload (5xx) handling", () => {
  const modelUrl = "https://example.test/v1beta/models/primary-model:generateContent"
  const noWait = { overloadDelaysMs: [0, 0] }
  const overloaded = (): Response =>
    new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 })
  let fetchSpy: jest.SpyInstance
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected request"))
  })
  afterEach(() => jest.restoreAllMocks())

  it("retries a 503 and returns the successful response", async () => {
    fetchSpy
      .mockResolvedValueOnce(overloaded())
      .mockResolvedValueOnce(new Response('{"candidates":[]}'))
    await expect(requestGemini(modelUrl, "key", body, undefined, noWait)).resolves.toEqual({
      candidates: [],
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("gives up after three overloaded attempts when no fallback is configured", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(overloaded()))
    await expect(
      requestGemini(modelUrl, "key", body, undefined, { ...noWait, fallbackModel: "" })
    ).rejects.toBeInstanceOf(GeminiUnavailableError)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("switches to the fallback model when the primary stays overloaded", async () => {
    fetchSpy.mockImplementation((input: string) =>
      Promise.resolve(
        input.includes("/models/backup-model:") ? new Response('{"candidates":[]}') : overloaded()
      )
    )
    await expect(
      requestGemini(modelUrl, "key", body, undefined, { ...noWait, fallbackModel: "backup-model" })
    ).resolves.toEqual({ candidates: [] })
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect((fetchSpy.mock.calls as Array<[string]>)[3]?.[0]).toBe(
      "https://example.test/v1beta/models/backup-model:generateContent"
    )
  })

  it("switches to the fallback model when the primary times out", async () => {
    fetchSpy
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }))
      .mockResolvedValueOnce(new Response('{"candidates":[]}'))
    await expect(
      requestGemini(modelUrl, "key", body, undefined, { ...noWait, fallbackModel: "backup-model" })
    ).resolves.toEqual({ candidates: [] })
    expect((fetchSpy.mock.calls as Array<[string]>)[1]?.[0]).toContain("/models/backup-model:")
  })

  it("switches to the fallback model when the primary is rate limited for too long", async () => {
    fetchSpy.mockImplementation((input: string) =>
      Promise.resolve(
        input.includes("/models/backup-model:")
          ? new Response('{"candidates":[]}')
          : throttle("Rate limit", "39")
      )
    )
    await expect(
      requestGemini(modelUrl, "key", body, undefined, { ...noWait, fallbackModel: "backup-model" })
    ).resolves.toEqual({ candidates: [] })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("surfaces the fallback's rate limit when both models are throttled", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(throttle("Rate limit", "39")))
    await expect(
      requestGemini(modelUrl, "key", body, undefined, { ...noWait, fallbackModel: "backup-model" })
    ).rejects.toThrow("39 seconds")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("does not retry or fall back on other client errors", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 400 }))
    await expect(
      requestGemini(modelUrl, "key", body, undefined, { ...noWait, fallbackModel: "backup-model" })
    ).rejects.toThrow("Gemini API error: 400")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
