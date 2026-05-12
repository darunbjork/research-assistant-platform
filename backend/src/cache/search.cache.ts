// backend/src/cache/search.cache.ts
// Redis cache for hybrid search results.
//
// WHAT IS CACHED:
// The output of HybridSearchService.search() — an array of HybridSearchResult.
// This is the most expensive operation per query AFTER generation
// (pgvector cosine search + BM25 keyword search + RRF merge).
//
// CACHE KEY DESIGN:
// Key: "search:{sha256(query + userId + topK + documentIds)}"
//
// WHY INCLUDE userId IN THE KEY:
// Each user has their own documents. User A's search for "revenue"
// returns different chunks than User B's search for "revenue".
// Without userId in the key, User A could see User B's cached results.
// Data isolation is maintained through the cache key.
//
// WHY 5 MINUTE TTL:
// Short enough that new document uploads are reflected quickly.
// Long enough to benefit repeated queries during a session.
// If a user uploads a document, their next search will miss the cache
// and see the new chunks immediately (because topK or documentIds change).
//
// CACHE INVALIDATION:
// When a document is deleted: we clear all search cache entries for that user.
// When a document is uploaded: the next search automatically misses cache
// (because the new chunks change the results).

import type Redis from "ioredis"
import crypto from "crypto"
import type { HybridSearchResult } from "../types/retrieval.types"
import { logRagEvent, logError } from "../utils/logger"

// ── Constants ─────────────────────────────────────────────────────────────
const CACHE_TTL_SECONDS = 300 // 5 minutes
const CACHE_PREFIX = "search"

// ── Cache Stats ───────────────────────────────────────────────────────────
interface CacheStats {
  hits: number
  misses: number
  hitRate: number
}

let cacheHits = 0
let cacheMisses = 0

export class SearchCache {
  constructor(private readonly redis: Redis) {}

  // ── get ───────────────────────────────────────────────────────────────
  // Returns cached search results, or null if not cached.
  async get(
    query: string,
    userId: string,
    topK: number,
    documentIds: string[] = []
  ): Promise<HybridSearchResult[] | null> {
    const key = this.buildKey(query, userId, topK, documentIds)

    try {
      const cached = await this.redis.get(key)
      if (cached === null) {
        cacheMisses++
        return null
      }

      cacheHits++
      const parsed = JSON.parse(cached) as HybridSearchResult[]

      logRagEvent("retrieve", "Search cache hit", {
        service: "SearchCache",
        chunkCount: parsed.length,
      })

      return parsed
    } catch (error: unknown) {
      logError("Search cache read failed", error, { service: "SearchCache" })
      cacheMisses++
      return null // cache failure is non-fatal
    }
  }

  // ── set ───────────────────────────────────────────────────────────────
  // Stores search results in Redis with TTL.
  async set(
    query: string,
    userId: string,
    topK: number,
    results: HybridSearchResult[],
    documentIds: string[] = []
  ): Promise<void> {
    const key = this.buildKey(query, userId, topK, documentIds)

    try {
      await this.redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(results))

      logRagEvent("retrieve", "Search results cached", {
        service: "SearchCache",
        chunkCount: results.length,
      })
    } catch (error: unknown) {
      logError("Search cache write failed", error, { service: "SearchCache" })
      // non-fatal — the search result is still returned to the caller
    }
  }

  // ── invalidateForUser ─────────────────────────────────────────────────
  // Deletes all search cache entries for a user.
  // Called when a user deletes a document — their cached results may be stale.
  async invalidateForUser(userId: string): Promise<number> {
    try {
      // Scan for all keys matching this user's search cache entries
      const pattern = `${CACHE_PREFIX}:${userId.slice(0, 8)}:*`
      const keys = await this.scanKeys(pattern)

      if (keys.length === 0) return 0

      await this.redis.del(...keys)

      logRagEvent("retrieve", "Search cache invalidated for user", {
        service: "SearchCache",
        userId,
      })

      return keys.length
    } catch (error: unknown) {
      logError("Search cache invalidation failed", error, {
        service: "SearchCache",
        userId,
      })
      return 0
    }
  }

  // ── invalidateAll ─────────────────────────────────────────────────────
  // Nuclear option: clear ALL search cache entries.
  // Use after bulk document changes or reindexing.
  async invalidateAll(): Promise<number> {
    try {
      const keys = await this.scanKeys(`${CACHE_PREFIX}:*`)
      if (keys.length === 0) return 0
      await this.redis.del(...keys)
      return keys.length
    } catch (error: unknown) {
      logError("Full search cache invalidation failed", error, {
        service: "SearchCache",
      })
      return 0
    }
  }

  // ── getStats ──────────────────────────────────────────────────────────
  getStats(): CacheStats {
    const total = cacheHits + cacheMisses
    return {
      hits: cacheHits,
      misses: cacheMisses,
      hitRate: total === 0 ? 0 : cacheHits / total,
    }
  }

  // ── Private: Build Cache Key ──────────────────────────────────────────
  // Deterministic key based on all query parameters.
  // Two queries that differ only in whitespace get different keys —
  // this is intentional: "ML" and "  ML  " may return different results.
  private buildKey(query: string, userId: string, topK: number, documentIds: string[]): string {
    // Normalise: lowercase, trim, sort documentIds for consistent key
    const normalised = JSON.stringify({
      q: query.toLowerCase().trim(),
      u: userId,
      k: topK,
      docs: [...documentIds].sort(),
    })

    const hash = crypto.createHash("sha256").update(normalised).digest("hex").slice(0, 24) // 96 bits — sufficient collision resistance

    // Include the first 8 chars of userId for efficient user-level invalidation
    return `${CACHE_PREFIX}:${userId.slice(0, 8)}:${hash}`
  }

  // ── Private: Scan Redis Keys ──────────────────────────────────────────
  // Uses SCAN instead of KEYS to avoid blocking Redis on large datasets.
  // KEYS pattern: blocks Redis until scan is complete (dangerous in production).
  // SCAN pattern: iterative, non-blocking, safe for large key spaces.
  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = []
    let cursor = "0"

    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", "100")
      cursor = nextCursor
      keys.push(...batch)
    } while (cursor !== "0")

    return keys
  }
}
