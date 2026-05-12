// backend/src/__tests__/search.cache.test.ts
// Tests for SearchCache.

import { SearchCache } from "../cache/search.cache"
import type { HybridSearchResult } from "../types/retrieval.types"

// ── Mock Redis Client ─────────────────────────────────────────────────────
class MockRedis {
  private store = new Map<string, { value: string; ttl: number }>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null
  }

  async setex(key: string, ttl: number, value: string): Promise<void> {
    this.store.set(key, { value, ttl })
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0
    for (const key of keys) {
      if (this.store.delete(key)) deleted++
    }
    return deleted
  }

  // Simplified SCAN — returns all matching keys in one pass
  async scan(
    _cursor: string,
    _matchCmd: "MATCH",
    pattern: string,
    _countCmd: "COUNT",
    _count: string
  ): Promise<[string, string[]]> {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/:/g, ":") + "$")
    const matches = [...this.store.keys()].filter(k => regex.test(k))
    return ["0", matches] // cursor "0" means scan is complete
  }

  clear(): void {
    this.store.clear()
  }

  size(): number {
    return this.store.size
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────
function makeHybridResult(id = "chunk-1"): HybridSearchResult {
  return {
    chunk: {
      id,
      documentId: "doc-1",
      content: "Machine learning content.",
      chunkIndex: 0,
      tokenCount: 5,
      source: "test.txt",
      pageNumber: null,
      chunkingStrategy: "recursive",
      createdAt: new Date(),
    },
    vectorRank: 0,
    keywordRank: 0,
    rrfScore: 0.032,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("SearchCache", () => {
  let cache: SearchCache
  let mockRedis: MockRedis

  beforeEach(() => {
    mockRedis = new MockRedis()
    cache = new SearchCache(mockRedis as never)
  })

  // ── get() — cache miss ─────────────────────────────────────────────────
  describe("get() — cache miss", () => {
    it("returns null when key does not exist", async () => {
      const result = await cache.get("query", "user-1", 10)
      expect(result).toBeNull()
    })

    it("returns null for a different userId", async () => {
      const results = [makeHybridResult()]
      await cache.set("query", "user-1", 10, results)

      const retrieved = await cache.get("query", "user-2", 10)
      expect(retrieved).toBeNull()
    })

    it("returns null for a different topK", async () => {
      const results = [makeHybridResult()]
      await cache.set("query", "user-1", 10, results)

      const retrieved = await cache.get("query", "user-1", 5)
      expect(retrieved).toBeNull()
    })
  })

  // ── get() and set() — cache hit ────────────────────────────────────────
  describe("get() and set() — cache hit", () => {
    it("returns stored results after set()", async () => {
      const results = [makeHybridResult()]
      await cache.set("what is ML?", "user-1", 10, results)

      const retrieved = await cache.get("what is ML?", "user-1", 10)
      expect(retrieved).not.toBeNull()
      expect(retrieved).toHaveLength(1)
    })

    it("preserves chunk content through cache round-trip", async () => {
      const results = [makeHybridResult("chunk-xyz")]
      await cache.set("test query", "user-1", 10, results)

      const retrieved = await cache.get("test query", "user-1", 10)
      expect(retrieved?.[0]?.chunk.id).toBe("chunk-xyz")
    })

    it("preserves RRF scores through cache round-trip", async () => {
      const results = [{ ...makeHybridResult(), rrfScore: 0.04567 }]
      await cache.set("query", "user-1", 5, results)

      const retrieved = await cache.get("query", "user-1", 5)
      expect(retrieved?.[0]?.rrfScore).toBeCloseTo(0.04567, 4)
    })

    it("preserves multiple results in correct order", async () => {
      const results = [
        makeHybridResult("chunk-a"),
        makeHybridResult("chunk-b"),
        makeHybridResult("chunk-c"),
      ]
      await cache.set("query", "user-1", 10, results)

      const retrieved = await cache.get("query", "user-1", 10)
      expect(retrieved?.[0]?.chunk.id).toBe("chunk-a")
      expect(retrieved?.[1]?.chunk.id).toBe("chunk-b")
      expect(retrieved?.[2]?.chunk.id).toBe("chunk-c")
    })

    it("same query with different case produces different cache entry", async () => {
      const results = [makeHybridResult()]
      await cache.set("Machine Learning", "user-1", 10, results)

      // lowercase version should miss the cache (different key)
      // because we normalise to lowercase in buildKey()
      const retrieved = await cache.get("machine learning", "user-1", 10)
      // This should hit because we normalise query to lowercase
      expect(retrieved).not.toBeNull()
    })
  })

  // ── invalidateForUser() ────────────────────────────────────────────────
  describe("invalidateForUser()", () => {
    it("removes cache entries for the specified user", async () => {
      await cache.set("query 1", "user-abc", 10, [makeHybridResult()])
      await cache.set("query 2", "user-abc", 10, [makeHybridResult()])

      await cache.invalidateForUser("user-abc")

      const result1 = await cache.get("query 1", "user-abc", 10)
      const result2 = await cache.get("query 2", "user-abc", 10)

      expect(result1).toBeNull()
      expect(result2).toBeNull()
    })

    it("does NOT remove cache entries for other users", async () => {
      await cache.set("query", "user-keep", 10, [makeHybridResult()])
      await cache.set("query", "user-delete", 10, [makeHybridResult()])

      await cache.invalidateForUser("user-delete")

      // user-keep's cache should be untouched
      const keepResult = await cache.get("query", "user-keep", 10)
      expect(keepResult).not.toBeNull()
    })

    it("returns the number of deleted keys", async () => {
      await cache.set("query 1", "user-1", 10, [makeHybridResult()])
      await cache.set("query 2", "user-1", 10, [makeHybridResult()])

      const deleted = await cache.invalidateForUser("user-1")
      expect(deleted).toBe(2)
    })

    it("returns 0 when no entries exist for user", async () => {
      const deleted = await cache.invalidateForUser("nonexistent-user")
      expect(deleted).toBe(0)
    })
  })

  // ── invalidateAll() ────────────────────────────────────────────────────
  describe("invalidateAll()", () => {
    it("clears all search cache entries", async () => {
      await cache.set("query 1", "user-1", 10, [makeHybridResult()])
      await cache.set("query 2", "user-2", 10, [makeHybridResult()])

      await cache.invalidateAll()

      const r1 = await cache.get("query 1", "user-1", 10)
      const r2 = await cache.get("query 2", "user-2", 10)
      expect(r1).toBeNull()
      expect(r2).toBeNull()
    })
  })

  // ── getStats() ─────────────────────────────────────────────────────────
  describe("getStats()", () => {
    it("tracks hits and misses correctly", async () => {
      // Miss
      await cache.get("missing", "user-1", 10)

      // Hit
      await cache.set("present", "user-1", 10, [makeHybridResult()])
      await cache.get("present", "user-1", 10)

      const stats = cache.getStats()
      expect(stats.misses).toBeGreaterThanOrEqual(1)
      expect(stats.hits).toBeGreaterThanOrEqual(1)
    })

    it("hitRate is between 0 and 1", async () => {
      const stats = cache.getStats()
      expect(stats.hitRate).toBeGreaterThanOrEqual(0)
      expect(stats.hitRate).toBeLessThanOrEqual(1)
    })
  })

  // ── documentIds in cache key ────────────────────────────────────────────
  describe("documentIds in cache key", () => {
    it("same query with different documentIds produces different cache entry", async () => {
      const results = [makeHybridResult()]
      await cache.set("query", "user-1", 10, results, ["doc-1"])

      // Without documentIds — should miss
      const noDocsResult = await cache.get("query", "user-1", 10, [])
      expect(noDocsResult).toBeNull()
    })

    it("documentIds order does not matter (sorted in key)", async () => {
      const results = [makeHybridResult()]
      await cache.set("query", "user-1", 10, results, ["doc-b", "doc-a"])

      // Same documentIds in different order should hit
      const retrieved = await cache.get("query", "user-1", 10, ["doc-a", "doc-b"])
      expect(retrieved).not.toBeNull()
    })
  })
})
