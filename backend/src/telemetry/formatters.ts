// backend/src/telemetry/formatters.ts
// Utilities for formatting trace data in logs and API responses.
// Makes trace IDs human-readable and useful for debugging.

import { trace } from "@opentelemetry/api"

// ── Get Current Trace ID ──────────────────────────────────────────────────
// Returns the trace ID of the current active span.
// Add this to every API response so users can report "trace ID: abc123"
// and you can look it up in Jaeger.
export function getCurrentTraceId(): string | null {
  const span = trace.getActiveSpan()
  if (!span) return null

  const ctx = span.spanContext()
  return ctx.traceId || null
}

// ── Format Trace URL ──────────────────────────────────────────────────────
// Returns a URL to the Jaeger trace viewer for the current trace.
// Include this in error responses so developers can click directly to the trace.
export function getJaegerTraceUrl(traceId: string): string {
  const jaegerBase = process.env.JAEGER_UI_URL ?? "http://localhost:16686"
  return `${jaegerBase}/trace/${traceId}`
}

// ── Trace Context for Logs ────────────────────────────────────────────────
// Returns trace context that can be merged into log records.
// This enables log-trace correlation in Grafana.
export function getLogTraceContext(): Record<string, string> {
  const span = trace.getActiveSpan()
  if (!span) return {}

  const ctx = span.spanContext()
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
  }
}
