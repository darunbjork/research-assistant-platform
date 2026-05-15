// backend/src/__tests__/embedding.service.test.ts
// Tests for EmbeddingService.

import { EmbeddingService } from "../services/embedding.service"

// ── Mock Redis Client ─────────────────────────────────────────────────────
class MockRedisClient {
  private store = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async setex(key: string, _ttl: number, value: string): Promise<void> {
    this.store.set(key, value)
  }

  has(key: string): boolean {
    return this.store.has(key)
  }

  clear(): void {
    this.store.clear()
  }
}

// ── Mock Gemini API Response ──────────────────────────────────────────────
// Returns N embeddings of 3072 dimensions (gemini-embedding-001).
function makeMockGeminiResponse(count: number, fillValue: number = 0.1): Response {
  const embeddings = Array.from({ length: count }, () => ({
    values: Array(3072).fill(fillValue) as number[],
  }))
  return new Response(JSON.stringify({ embeddings }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// ── Test Suite Setup ──────────────────────────────────────────────────────
describe("EmbeddingService", () => {
  let service: EmbeddingService
  let mockRedis: MockRedisClient
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    mockRedis = new MockRedisClient()
    service = new EmbeddingService("fake-api-key-for-tests", mockRedis as never)
    fetchSpy = jest.spyOn(global, "fetch")
    fetchSpy.mockResolvedValue(makeMockGeminiResponse(1))
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  // ── Constructor ────────────────────────────────────────────────────────
  describe("constructor", () => {
    it("throws if API key is empty", () => {
      expect(() => {
        new EmbeddingService("", mockRedis as never)
      }).toThrow("EmbeddingService requires a Gemini API key")
    })

    it("throws if API key is whitespace only", () => {
      expect(() => {
        new EmbeddingService("   ", mockRedis as never)
      }).toThrow("EmbeddingService requires a Gemini API key")
    })

    it("does not throw with a valid API key", () => {
      expect(() => {
        new EmbeddingService("valid-key-abc123", mockRedis as never)
      }).not.toThrow()
    })
  })

  // ── embedText ─────────────────────────────────────────────────────────
  describe("embedText()", () => {
    it("returns an array of 3072 numbers", async () => {
      const vector = await service.embedText("What is machine learning?")
      expect(Array.isArray(vector)).toBe(true)
      expect(vector).toHaveLength(3072)
    })

    it("returns numbers (not strings or nulls)", async () => {
      const vector = await service.embedText("test text")
      vector.forEach(value => {
        expect(typeof value).toBe("number")
        expect(value).not.toBeNaN()
      })
    })

    it("calls the Gemini API exactly once for a fresh text", async () => {
      await service.embedText("fresh text never seen before")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it("does NOT call the API on a second call for the same text", async () => {
      const text = "this text will be cached"
      await service.embedText(text)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      await service.embedText(text)
      expect(fetchSpy).toHaveBeenCalledTimes(1) // still 1
    })

    it("returns the same vector on repeated calls (from cache)", async () => {
      const text = "deterministic caching test"
      const vector1 = await service.embedText(text)
      const vector2 = await service.embedText(text)
      expect(vector1).toEqual(vector2)
    })

    it("calls the API with RETRIEVAL_DOCUMENT task type by default", async () => {
      await service.embedText("search query")
      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, { body: string }])[1].body
      ) as { requests: Array<{ taskType: string }> }
      expect(callBody.requests[0]?.taskType).toBe("RETRIEVAL_DOCUMENT")
    })

    it("uses RETRIEVAL_DOCUMENT task type when specified", async () => {
      await service.embedText("document chunk", "RETRIEVAL_DOCUMENT")
      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, { body: string }])[1].body
      ) as { requests: Array<{ taskType: string }> }
      expect(callBody.requests[0]?.taskType).toBe("RETRIEVAL_DOCUMENT")
    })
  })

  // ── embedBatch ────────────────────────────────────────────────────────
  describe("embedBatch()", () => {
    it("returns empty array for empty input", async () => {
      const result = await service.embedBatch([])
      expect(result).toEqual([])
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("returns one vector per input text", async () => {
      const texts = ["text one", "text two", "text three"]
      fetchSpy.mockResolvedValueOnce(makeMockGeminiResponse(3))
      const vectors = await service.embedBatch(texts)
      expect(vectors).toHaveLength(3)
    })

    it("each vector has 3072 dimensions", async () => {
      fetchSpy.mockResolvedValueOnce(makeMockGeminiResponse(2))
      const vectors = await service.embedBatch(["text a", "text b"])
      vectors.forEach(vector => {
        expect(vector).toHaveLength(3072)
      })
    })

    it("makes only ONE API call for a batch of texts", async () => {
      fetchSpy.mockResolvedValueOnce(makeMockGeminiResponse(5))
      await service.embedBatch(["a", "b", "c", "d", "e"])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it("uses cache for texts already embedded — skips API for those", async () => {
      const cachedText = "this is already cached"
      const uncachedText = "this is brand new"
      await service.embedText(cachedText)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      fetchSpy.mockClear()
      fetchSpy.mockResolvedValueOnce(makeMockGeminiResponse(1))
      const vectors = await service.embedBatch([cachedText, uncachedText])
      expect(fetchSpy).toHaveBeenCalledTimes(1) // only uncached text triggers API
      expect(vectors).toHaveLength(2)
    })

    it("preserves the order of vectors matching the order of input texts", async () => {
      const responses = [0.1, 0.2, 0.3]
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            embeddings: responses.map(v => ({
              values: Array(3072).fill(v) as number[],
            })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      const vectors = await service.embedBatch(["a", "b", "c"])
      expect(vectors[0]?.[0]).toBeCloseTo(0.1)
      expect(vectors[1]?.[0]).toBeCloseTo(0.2)
      expect(vectors[2]?.[0]).toBeCloseTo(0.3)
    })
  })

  // ── Error Handling ─────────────────────────────────────────────────────
  describe("error handling", () => {
    it("throws a descriptive error when the API returns 429 (rate limit)", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Resource exhausted" } }), {
          status: 429,
          statusText: "Too Many Requests",
        })
      )
      await expect(service.embedText("rate limited text")).rejects.toThrow(
        "Gemini embedding API error: 429"
      )
    })

    it("throws a descriptive error when the API returns 401 (invalid key)", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "API key not valid" } }), {
          status: 401,
          statusText: "Unauthorized",
        })
      )
      await expect(service.embedText("auth failed")).rejects.toThrow(
        "Gemini embedding API error: 401"
      )
    })

    it("throws when API returns wrong number of embeddings", async () => {
      fetchSpy.mockResolvedValueOnce(makeMockGeminiResponse(1))
      await expect(service.embedBatch(["text one", "text two"])).rejects.toThrow(
        "Gemini returned 1 embeddings for 2 texts"
      )
    })

    it("continues without cache if Redis is unavailable", async () => {
      const brokenRedis = {
        get: jest.fn().mockRejectedValue(new Error("Redis connection refused")),
        setex: jest.fn().mockRejectedValue(new Error("Redis connection refused")),
      }
      const serviceWithBrokenRedis = new EmbeddingService("fake-key", brokenRedis as never)
      fetchSpy.mockResolvedValueOnce(makeMockGeminiResponse(1))
      const vector = await serviceWithBrokenRedis.embedText("text with broken redis")
      expect(vector).toHaveLength(3072)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ── Cache Stats ────────────────────────────────────────────────────────
  describe("getCacheStats()", () => {
    it("starts with zero hits and misses", () => {
      const stats = service.getCacheStats()
      expect(stats.hits).toBe(0)
      expect(stats.misses).toBe(0)
      expect(stats.hitRate).toBe(0)
    })

    it("tracks cache misses correctly", async () => {
      await service.embedText("first time")
      const stats = service.getCacheStats()
      expect(stats.misses).toBe(1)
      expect(stats.hits).toBe(0)
    })

    it("tracks cache hits correctly", async () => {
      const text = "embed twice"
      await service.embedText(text) // miss
      await service.embedText(text) // hit
      const stats = service.getCacheStats()
      expect(stats.hits).toBe(1)
      expect(stats.misses).toBe(1)
      expect(stats.hitRate).toBe(0.5)
    })

    it("hitRate reaches 1.0 when all requests are cache hits", async () => {
      const text = "perfect cache"
      await service.embedText(text) // miss
      fetchSpy.mockClear()
      await service.embedText(text) // hit
      await service.embedText(text) // hit
      await service.embedText(text) // hit
      const stats = service.getCacheStats()
      expect(stats.hitRate).toBeCloseTo(0.75)
    })
  })
})
