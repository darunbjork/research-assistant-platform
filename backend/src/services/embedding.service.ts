// backend/src/services/embedding.service.ts
// Updated Day 22: OpenTelemetry spans on Gemini embedding calls.

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
import { getTracer } from "../telemetry/tracer"
import { withSpan, LLM_ATTRS, RAG_ATTRS } from "../telemetry/spans"

// ── Constants ─────────────────────────────────────────────────────────────
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const EMBEDDING_DIMENSIONS = 3072
const CACHE_TTL_SECONDS = 86_400 // 24 hours
const MAX_BATCH_SIZE = 100 // Gemini API limit per batchEmbedContents call

export class EmbeddingService {
  private cacheHits = 0
  private cacheMisses = 0
  private readonly tracer = getTracer("embedding.service")

  constructor(
    private readonly apiKey: string,
    private readonly redisClient: Redis
  ) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error(
        "EmbeddingService requires a Gemini API key. Set GEMINI_API_KEY in your .env file."
      )
    }
  }

  // ── embedText ─────────────────────────────────────────────────────────
  async embedText(
    text: string,
    taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" = "RETRIEVAL_DOCUMENT"
  ): Promise<number[]> {
    return withSpan(this.tracer, "embedding.embedText", async span => {
      span.setAttribute(LLM_ATTRS.SYSTEM, "google_gemini")
      span.setAttribute(LLM_ATTRS.MODEL, "text-embedding-004")
      span.setAttribute(LLM_ATTRS.OPERATION, "embed")
      span.setAttribute("embedding.task_type", taskType)
      span.setAttribute("embedding.text_length", text.length)

      // Check cache first using existing helper
      const cachedVector = await this.getFromCache(text)
      if (cachedVector !== null) {
        span.setAttribute(RAG_ATTRS.CACHE_HIT, true)
        this.cacheHits++
        logRagEvent("embed", "Embedding cache hit", {
          service: "EmbeddingService",
          textLength: text.length,
        })
        return cachedVector
      }

      span.setAttribute(RAG_ATTRS.CACHE_HIT, false)
      this.cacheMisses++

      // Call Gemini API
      const timer = embeddingLatency.startTimer()
      embeddingRequests.inc({ status: "success" })

      const embedding = await this.callGeminiApi([text], taskType)
      const vector = embedding[0]
      if (vector === undefined) {
        throw new Error("Gemini returned no embedding vector")
      }

      timer()
      tokenCost.inc({ operation: "embedding" }, EMBEDDING_DIMENSIONS)

      span.setAttribute("embedding.dimensions", vector.length)
      span.setAttribute(LLM_ATTRS.OUTPUT_TOKENS, vector.length)

      // Store in cache
      await this.setInCache(text, vector)

      logRagEvent("embed", "Embedding generated", {
        service: "EmbeddingService",
        durationMs: Date.now() - (Date.now() - 0), // timer already measured
      })

      return vector
    })
  }

  // ── embedBatch ────────────────────────────────────────────────────────
  async embedBatch(
    texts: string[],
    taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" = "RETRIEVAL_DOCUMENT"
  ): Promise<number[][]> {
    return withSpan(this.tracer, "embedding.embedBatch", async span => {
      span.setAttribute(LLM_ATTRS.SYSTEM, "google_gemini")
      span.setAttribute(LLM_ATTRS.MODEL, "text-embedding-004")
      span.setAttribute(LLM_ATTRS.OPERATION, "embed_batch")
      span.setAttribute("embedding.batch_size", texts.length)
      span.setAttribute("embedding.task_type", taskType)

      // Use existing cache helpers and batch splitting logic
      const cacheKeys = texts.map(t => this.cacheKey(t))
      const cached = await Promise.all(cacheKeys.map(k => this.redisClient.get(k)))

      const results = new Array<number[]>(texts.length)
      const toEmbed: Array<{ index: number; text: string }> = []

      cached.forEach((c, i) => {
        if (c !== null) {
          results[i] = JSON.parse(c) as number[]
          this.cacheHits++
        } else {
          toEmbed.push({ index: i, text: texts[i]! })
          this.cacheMisses++
        }
      })

      span.setAttribute(RAG_ATTRS.CACHE_HIT, toEmbed.length < texts.length)
      span.setAttribute("embedding.cache_hits", texts.length - toEmbed.length)
      span.setAttribute("embedding.cache_misses", toEmbed.length)

      if (toEmbed.length > 0) {
        const batches: Array<typeof toEmbed> = []
        for (let i = 0; i < toEmbed.length; i += MAX_BATCH_SIZE) {
          batches.push(toEmbed.slice(i, i + MAX_BATCH_SIZE))
        }

        for (const batch of batches) {
          const timer = embeddingLatency.startTimer()
          embeddingRequests.inc({ status: "success" })

          const embeddings = await this.callGeminiApi(
            batch.map(item => item.text),
            taskType
          )

          timer()
          tokenCost.inc({ operation: "embedding" }, embeddings.length * EMBEDDING_DIMENSIONS)

          batch.forEach((item, batchIdx) => {
            const vec = embeddings[batchIdx]
            if (vec !== undefined) {
              results[item.index] = vec
              void this.setInCache(item.text, vec)
            }
          })
        }
      }

      span.setAttribute(LLM_ATTRS.TOTAL_TOKENS, texts.length * EMBEDDING_DIMENSIONS)
      return results
    })
  }

  // ── getCacheStats ─────────────────────────────────────────────────────
  getCacheStats(): { hits: number; misses: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total === 0 ? 0 : this.cacheHits / total,
    }
  }

  // ── Private: Gemini API call (single batch, no splitting) ──────────────
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
      let errorMessage = `Gemini embedding API error: ${response.status} ${response.statusText}`
      try {
        const errorBody = (await response.json()) as { error?: { message?: string } }
        if (errorBody.error?.message) {
          errorMessage += ` — ${errorBody.error.message}`
        }
      } catch {
        // ignore parse error
      }
      throw new Error(errorMessage)
    }

    const data = (await response.json()) as GeminiEmbedResponse

    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error(
        `Gemini returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} texts`
      )
    }

    data.embeddings.forEach((embedding, index) => {
      if (embedding.values.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding at index ${index} has ${embedding.values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`
        )
      }
    })

    return data.embeddings.map(e => e.values ?? [])
  }

  // ── Private: Cache helpers ───────────────────────────────────────────
  private cacheKey(text: string): string {
    const hash = crypto.createHash("sha256").update(text.trim()).digest("hex").slice(0, 32)
    return `embedding:${GEMINI_EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}:${hash}`
  }

  private async getFromCache(text: string): Promise<number[] | null> {
    try {
      const key = this.cacheKey(text)
      const cached = await this.redisClient.get(key)
      if (cached === null) return null
      const parsed = JSON.parse(cached) as CachedEmbedding
      return parsed.vector
    } catch (error) {
      logError("Redis cache read failed", error, { service: "EmbeddingService" })
      return null
    }
  }

  private async setInCache(text: string, vector: number[]): Promise<void> {
    try {
      const key = this.cacheKey(text)
      const payload: CachedEmbedding = {
        vector,
        model: GEMINI_EMBEDDING_MODEL,
        createdAt: new Date().toISOString(),
      }
      await this.redisClient.setex(key, CACHE_TTL_SECONDS, JSON.stringify(payload))
    } catch (error) {
      logError("Redis cache write failed", error, { service: "EmbeddingService" })
    }
  }
}
