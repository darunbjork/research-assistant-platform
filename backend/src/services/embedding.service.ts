// TODO: Converts text into 768-dimensional vectors using the Gemini embedding API.
//
// ? TWO CORE OPERATIONS:
//
// * 1. embedText(text)  — embed one string (used for query embedding at search time)
// * 2. embedBatch(texts) — embed many strings in one API call (used during ingestion)
//
// WHY BATCH MATTERS:
// Ingesting a 50-page PDF might produce 200 chunks.
// Embedding one by one: 200 API calls × 100ms = 20 seconds + 200 × rate limit hit risk
// Embedding in batches of 100: 2 API calls × 100ms = 0.2 seconds
//
// REDIS CACHE LAYER:
// Every text is hashed with SHA-256 before embedding.
// Same text → same hash → check Redis first.
// Cache hit: return vector instantly (< 1ms).
// Cache miss: call Gemini → store in Redis → return vector.
// TTL: 24 hours (embeddings are stable — the same text always produces the same vector)

import crypto from "crypto"
import type Redis from "ioredis"
import type {
  GeminiEmbedRequest,
  GeminiEmbedResponse,
  CachedEmbedding,
  EmbeddingTaskType,
} from "../types/llm.types"
import { logRagEvent, logError } from "../utils/logger"
import { embeddingRequests, embeddingLatency, tokenCost } from "../utils/metrics"

// ── Constants ─────────────────────────────────────────────────────────────
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const EMBEDDING_DIMENSIONS = 3072
const CACHE_TTL_SECONDS = 86_400 // 24 hours
const MAX_BATCH_SIZE = 100 // Gemini API limit per batchEmbedContents call

export class EmbeddingService {
  // Track cache hits and misses for the /metrics endpoint
  private cacheHits = 0
  private cacheMisses = 0

  constructor(
    private readonly apiKey: string,
    private readonly redisClient: Redis
  ) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error(
        "EmbeddingService requires a Gemini API key. " + "Set GEMINI_API_KEY in your .env file."
      )
    }
  }

  // ── embedText ─────────────────────────────────────────────────────────
  // Embed a single string. Used when a user submits a query at search time.
  // taskType: RETRIEVAL_QUERY tells Gemini this is a search query, not a document.
  async embedText(
    text: string,
    taskType: EmbeddingTaskType = "RETRIEVAL_QUERY"
  ): Promise<number[]> {
    const vectors = await this.embedBatch([text], taskType)

    const result = vectors[0]
    if (result === undefined || result.length === 0) {
      throw new Error("Embedding API returned empty vector for single text")
    }

    return result
  }

  // ── embedBatch ────────────────────────────────────────────────────────
  // Embed many strings efficiently.
  // 1. Check Redis cache for each text
  // 2. Batch-call Gemini only for cache misses
  // 3. Store new vectors in Redis
  // 4. Return all vectors in the same order as the input texts
  //
  // taskType: RETRIEVAL_DOCUMENT for chunk ingestion, RETRIEVAL_QUERY for searches
  async embedBatch(
    texts: string[],
    taskType: EmbeddingTaskType = "RETRIEVAL_DOCUMENT"
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return []
    }

    const timer = embeddingLatency.startTimer()
    const start = Date.now()

    // Step 1: Check Redis cache for every text in parallel
    const cacheResults = await Promise.all(texts.map(text => this.getFromCache(text)))

    // Step 2: Identify which texts are NOT in the cache (cache misses)
    const missIndices: number[] = [] // positions in the original texts array
    const missTexts: string[] = [] // the actual text strings to embed

    cacheResults.forEach((cached, index) => {
      if (cached === null) {
        missIndices.push(index)
        const text = texts[index]
        if (text !== undefined) {
          missTexts.push(text)
        }
      } else {
        this.cacheHits++
      }
    })

    // Step 3: Call Gemini API only for cache misses, in batches
    if (missTexts.length > 0) {
      this.cacheMisses += missTexts.length
      embeddingRequests.inc({ status: "api_call" })

      try {
        // Split into batches of MAX_BATCH_SIZE if needed
        const freshVectors = await this.callGeminiBatched(missTexts, taskType)

        // Step 4: Store fresh vectors in Redis and fill the results array
        await Promise.all(
          missTexts.map(async (text, i) => {
            const vector = freshVectors[i]
            if (vector !== undefined) {
              await this.setInCache(text, vector)
            }
          })
        )

        // Step 5: Merge fresh vectors back into the results array
        // cacheResults[missIndices[i]] was null — replace with fresh vector
        missIndices.forEach((originalIndex, i) => {
          const vector = freshVectors[i]
          if (vector !== undefined) {
            cacheResults[originalIndex] = vector
          }
        })

        embeddingRequests.inc({ status: "success" })
        // Rough token estimate: 4 chars ≈ 1 token per text
        const estimatedTokens = missTexts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0)
        tokenCost.inc({ operation: "embedding" }, estimatedTokens)
      } catch (error: unknown) {
        embeddingRequests.inc({ status: "error" })
        throw error
      }
    }

    timer()
    logRagEvent("embed", "Batch embedding complete", {
      service: "EmbeddingService",
      chunkCount: texts.length,
      durationMs: Date.now() - start,
    })

    // Filter nulls — every position should now have a vector
    // If any remain null, something went wrong with the API call
    const results = cacheResults.filter((v): v is number[] => v !== null)

    if (results.length !== texts.length) {
      throw new Error(
        `Embedding count mismatch: expected ${texts.length}, got ${results.length}. ` +
          `Some texts may have failed to embed.`
      )
    }

    return results
  }

  // ── getCacheStats ─────────────────────────────────────────────────────
  // Returns cache performance stats — useful for the /metrics endpoint
  getCacheStats(): { hits: number; misses: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total === 0 ? 0 : this.cacheHits / total,
    }
  }

  // ── Private: Call Gemini API in Batches ───────────────────────────────
  // Handles the MAX_BATCH_SIZE limit automatically.
  // If you pass 250 texts, this makes 3 API calls: [100, 100, 50].
  private async callGeminiBatched(
    texts: string[],
    taskType: EmbeddingTaskType
  ): Promise<number[][]> {
    const allVectors: number[][] = []

    // Split into chunks of MAX_BATCH_SIZE
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE)
      const batchVectors = await this.callGeminiApi(batch, taskType)
      allVectors.push(...batchVectors)
    }

    return allVectors
  }

  // ── Private: Single Gemini API Call ──────────────────────────────────
  private async callGeminiApi(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]> {
    const url = `${GEMINI_BASE_URL}/models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${this.apiKey}`

    const requestBody: GeminiEmbedRequest = {
      requests: texts.map(text => ({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        taskType,
      })),
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      // Parse the error body for a useful message
      let errorMessage = `Gemini embedding API error: ${response.status} ${response.statusText}`
      try {
        const errorBody = (await response.json()) as { error?: { message?: string } }
        if (errorBody.error?.message) {
          errorMessage += ` — ${errorBody.error.message}`
        }
      } catch {
        // Could not parse error body — use the status code message
      }
      throw new Error(errorMessage)
    }

    const data = (await response.json()) as GeminiEmbedResponse

    // Validate the response shape — the API could return fewer embeddings than requested
    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error(
        `Gemini returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} texts`
      )
    }

    // Validate each vector has the expected dimensions
    data.embeddings.forEach((embedding, index) => {
      if (embedding.values.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding at index ${index} has ${embedding.values.length} dimensions, ` +
            `expected ${EMBEDDING_DIMENSIONS}`
        )
      }
    })

    return data.embeddings.map(e => e.values)
  }

  // ── Private: Redis Cache Operations ──────────────────────────────────

  // Returns the cached vector, or null if not found
  private async getFromCache(text: string): Promise<number[] | null> {
    try {
      const key = this.cacheKey(text)
      const cached = await this.redisClient.get(key)

      if (cached === null) return null

      const parsed = JSON.parse(cached) as CachedEmbedding
      return parsed.vector
    } catch (error: unknown) {
      // Cache read failure is non-fatal — fall through to API call
      logError("Redis cache read failed", error, {
        service: "EmbeddingService",
      })
      return null
    }
  }

  // Stores a vector in Redis with 24-hour TTL
  private async setInCache(text: string, vector: number[]): Promise<void> {
    try {
      const key: string = this.cacheKey(text)

      const payload: CachedEmbedding = {
        vector,
        model: GEMINI_EMBEDDING_MODEL,
        createdAt: new Date().toISOString(),
      }

      // SETEX = SET with EXpiry
      // The vector is evicted after 24 hours — forces re-embedding with fresh models
      await this.redisClient.setex(key, CACHE_TTL_SECONDS, JSON.stringify(payload))
    } catch (error: unknown) {
      // Cache write failure is non-fatal — vector is still returned to caller
      logError("Redis cache write failed", error, {
        service: "EmbeddingService",
      })
    }
  }

  // Generates a deterministic cache key from text content
  // SHA-256 hash ensures: same text → same key, different text → different key
  // We take only the first 16 hex chars (64 bits) — collision probability is negligible
  private cacheKey(text: string): string {
    const hash = crypto
      .createHash("sha256")
      .update(text.trim()) // trim so "hello" and "hello " share the same cache entry
      .digest("hex")
      .slice(0, 32) // 32 hex chars = 128 bits — more than enough uniqueness

    return `embedding:${GEMINI_EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}:${hash}`
  }
}
