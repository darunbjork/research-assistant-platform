import { requestGemini } from "../utils/gemini-request"
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
