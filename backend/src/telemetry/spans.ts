// backend/src/telemetry/spans.ts
// Semantic span attribute constants and helper functions.
//
// WHY CONSTANTS FOR ATTRIBUTE NAMES:
// Span attributes are strings. A typo in "llm.model" produces
// "llm.mdoel" which is invisible until you query for it and get nothing.
// Using typed constants catches typos at compile time.
//
// SEMANTIC CONVENTIONS:
// We follow the OpenTelemetry Semantic Conventions for AI/ML systems
// (currently in draft but widely adopted):
//   https://opentelemetry.io/docs/specs/semconv/gen-ai/
// This makes our traces compatible with OTel-aware dashboards.

import { trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api"

// ── Semantic Attribute Keys ───────────────────────────────────────────────

// LLM / GenAI attributes (following OTel GenAI semantic conventions)
export const LLM_ATTRS = {
  MODEL: "gen_ai.request.model",
  MAX_TOKENS: "gen_ai.request.max_tokens",
  TEMPERATURE: "gen_ai.request.temperature",
  INPUT_TOKENS: "gen_ai.usage.input_tokens",
  OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  TOTAL_TOKENS: "gen_ai.usage.total_tokens",
  OPERATION: "gen_ai.operation.name", // "embed", "chat", "rerank"
  SYSTEM: "gen_ai.system", // "google_gemini"
} as const

// RAG-specific attributes (custom namespace)
export const RAG_ATTRS = {
  QUERY: "rag.query",
  CHUNKS_RETRIEVED: "rag.chunks.retrieved",
  CHUNKS_USED: "rag.chunks.used",
  STRATEGY: "rag.retrieval.strategy", // "hybrid", "vector", "keyword"
  CACHE_HIT: "rag.cache.hit",
  ITERATION: "rag.agent.iteration",
  TOOL_NAME: "rag.agent.tool",
  QUALITY_SCORE: "rag.eval.quality_score",
} as const

// Database attributes (following OTel DB semantic conventions)
export const DB_ATTRS = {
  SYSTEM: "db.system", // "postgresql"
  OPERATION: "db.operation", // "SELECT", "INSERT"
  TABLE: "db.sql.table",
  ROWS_AFFECTED: "db.rows_affected",
} as const

// HTTP attributes
export const HTTP_ATTRS = {
  USER_ID: "http.user_id",
  ENDPOINT: "http.endpoint",
} as const

// ── Span Helper Functions ─────────────────────────────────────────────────

// withSpan: wraps an async function in a span.
// The span starts before the function runs and ends when it completes.
// On error: the span is marked as failed and the error is re-thrown.
//
// Usage:
//   const result = await withSpan(tracer, "embedText", async (span) => {
//     span.setAttribute(LLM_ATTRS.MODEL, "gemini-embedding-004")
//     return await callGemini(text)
//   })
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {}
): Promise<T> {
  return tracer.startActiveSpan(name, async (span: Span) => {
    // Set initial attributes
    Object.entries(attributes).forEach(([key, value]) => {
      span.setAttribute(key, value)
    })

    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error: unknown) {
      // Mark span as failed and record the error
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })

      if (error instanceof Error) {
        span.recordException(error)
      }

      throw error // re-throw so the caller handles it
    } finally {
      span.end() // ALWAYS end the span
    }
  })
}

// withSyncSpan: wraps a synchronous function in a span
export function withSyncSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => T,
  attributes: Record<string, string | number | boolean> = {}
): T {
  return tracer.startActiveSpan(name, (span: Span) => {
    Object.entries(attributes).forEach(([key, value]) => {
      span.setAttribute(key, value)
    })

    try {
      const result = fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof Error) {
        span.recordException(error)
      }
      throw error
    } finally {
      span.end()
    }
  })
}

// getCurrentSpan: returns the current active span, if any.
// Use this to add attributes to spans created by auto-instrumentation.
export function getCurrentSpan(): Span | undefined {
  const span = trace.getActiveSpan()
  return span ?? undefined
}

// addSpanAttributes: safely adds attributes to the current active span.
// No-ops if there is no active span.
export function addSpanAttributes(attributes: Record<string, string | number | boolean>): void {
  const span = trace.getActiveSpan()
  if (span) {
    Object.entries(attributes).forEach(([key, value]) => {
      span.setAttribute(key, value)
    })
  }
}
