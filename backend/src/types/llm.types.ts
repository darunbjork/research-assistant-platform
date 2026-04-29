// TODO: All types for Gemini API requests and responses.
//
// * WHY TYPED RESPONSES MATTER FOR AI SYSTEMS:
// The Gemini API returns JSON. Without types, you write:
//   const vector = response.embeddings[0].values
// * TypeScript cannot tell you if "embeddings" is spelled wrong,
// or if "values" should be "embedding" instead.
// With types: the compiler catches every mistake at build time,
// before a wrong field name causes a silent empty vector at runtime.

// ── Embedding API Types ───────────────────────────────────────────────────

// What we send to the Gemini batchEmbedContents endpoint
export interface GeminiEmbedRequest {
  requests: GeminiEmbedRequestItem[]
}

export interface GeminiEmbedRequestItem {
  model: string // "models/text-embedding-004"
  content: {
    parts: Array<{ text: string }>
  }
  taskType?: EmbeddingTaskType
}

// Task type hints to the model what the embedding will be used for.
// RETRIEVAL_DOCUMENT: use when embedding chunks for storage
// RETRIEVAL_QUERY:    use when embedding user queries for search
// Using the correct task type improves retrieval accuracy by ~5-10%.
export type EmbeddingTaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"

// What the Gemini batchEmbedContents endpoint returns
export interface GeminiEmbedResponse {
  embeddings: Array<{
    values: number[] // the 768-dimensional vector
  }>
}

// ── Generation API Types ──────────────────────────────────────────────────
// Used from Day 11 (GenerationService) — defined now so the type system is complete.

export interface GeminiPart {
  text: string
}

export interface GeminiContent {
  parts: GeminiPart[]
  role?: "user" | "model"
}

export interface GeminiRequest {
  systemInstruction?: { parts: GeminiPart[] }
  contents: GeminiContent[]
  generationConfig?: GenerationConfig
}

export interface GenerationConfig {
  temperature: number // 0 = deterministic, 1 = creative
  topP: number // nucleus sampling threshold
  maxOutputTokens: number // cap on response length
}

export interface GeminiCandidate {
  content: GeminiContent
  finishReason: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER"
  safetyRatings: SafetyRating[]
}

export interface SafetyRating {
  category: string
  probability: string
}

export interface GeminiResponse {
  candidates: GeminiCandidate[]
  usageMetadata: UsageMetadata
}

export interface UsageMetadata {
  promptTokenCount: number
  candidatesTokenCount: number
  totalTokenCount: number
}

// ── Cache Types ───────────────────────────────────────────────────────────

// Metadata stored alongside the cached vector in Redis
export interface CachedEmbedding {
  vector: number[] // the 768-dimensional embedding
  model: string // which model produced this (for cache invalidation)
  createdAt: string // ISO timestamp
}

// Stats returned by the cache for monitoring
export interface CacheStats {
  hits: number // times a cached vector was returned
  misses: number // times the API had to be called
  hitRate: number // hits / (hits + misses) as 0-1
}
