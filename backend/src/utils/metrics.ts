// backend/src/utils/metrics.ts
// All Prometheus metrics for the Research Assistant Platform.
//
// METRIC NAMING CONVENTIONS (Prometheus best practice):
//   {service}_{noun}_{unit}_total    → counter
//   {service}_{noun}_{unit}          → gauge or histogram
//
// CARDINALITY WARNING:
// Each unique combination of label values creates a new time series.
// High cardinality (e.g., labels with user IDs) causes performance issues.
// Keep label values to a small, finite set.
//
// UNITS:
// Prometheus convention: use base units (seconds not milliseconds,
// bytes not kilobytes). Grafana converts to human-readable units.

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client"

// ── Registry ───────────────────────────────────────────────────────────────
// One registry per application — all metrics registered here.
export const register = new Registry()

// Collect default Node.js metrics (memory, CPU, event loop lag, etc.)
collectDefaultMetrics({ register })

// ── RAG Pipeline Metrics ──────────────────────────────────────────────────

export const ragRequests = new Counter({
  name: "rag_requests_total",
  help: "Total number of RAG pipeline requests",
  labelNames: ["status"], // "success" | "error"
  registers: [register],
})

export const retrievalLatency = new Histogram({
  name: "retrieval_latency_seconds",
  help: "End-to-end retrieval pipeline latency in seconds",
  labelNames: ["strategy"], // "hybrid" | "vector" | "keyword"
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0],
  registers: [register],
})

export const generationLatency = new Histogram({
  name: "generation_latency_seconds",
  help: "Gemini generation call latency in seconds",
  buckets: [0.1, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 30.0],
  registers: [register],
})

export const embeddingLatency = new Histogram({
  name: "embedding_latency_seconds",
  help: "Gemini embedding call latency in seconds",
  labelNames: ["cache_hit"], // "true" | "false"
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0],
  registers: [register],
})

export const chunksRetrieved = new Histogram({
  name: "chunks_retrieved_total",
  help: "Number of chunks retrieved per query",
  buckets: [1, 3, 5, 10, 15, 20],
  registers: [register],
})

// ── Embedding Cache Metrics ───────────────────────────────────────────────

export const embeddingCacheHits = new Counter({
  name: "embedding_cache_hits_total",
  help: "Total embedding cache hits",
  registers: [register],
})

export const embeddingCacheMisses = new Counter({
  name: "embedding_cache_misses_total",
  help: "Total embedding cache misses",
  registers: [register],
})

// ── Search Cache Metrics ──────────────────────────────────────────────────

export const searchCacheHits = new Counter({
  name: "search_cache_hits_total",
  help: "Total search result cache hits",
  registers: [register],
})

export const searchCacheMisses = new Counter({
  name: "search_cache_misses_total",
  help: "Total search result cache misses",
  registers: [register],
})

// ── Agent Metrics ─────────────────────────────────────────────────────────

export const agentIterations = new Counter({
  name: "agent_iterations_total",
  help: "Total agent ReAct loop iterations",
  labelNames: ["tool"], // "rag_search" | "calculator" | "web_search"
  registers: [register],
})

export const activeAgentSessions = new Gauge({
  name: "active_agent_sessions",
  help: "Currently active agent sessions (HTTP + WebSocket)",
  registers: [register],
})

export const agentQualityScore = new Histogram({
  name: "agent_quality_score",
  help: "Self-evaluation quality scores from the agent evaluator",
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [register],
})

// ── RAG Triad Evaluation Metrics ──────────────────────────────────────────

export const ragTriadScores = new Histogram({
  name: "rag_triad_score",
  help: "RAG Triad evaluation scores per dimension",
  labelNames: ["dimension"], // "context_relevance" | "faithfulness" | "answer_relevance"
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [register],
})

// ── Document Ingestion Metrics ────────────────────────────────────────────

export const indexedDocuments = new Counter({
  name: "indexed_documents_total",
  help: "Total documents successfully ingested and indexed",
  registers: [register],
})

export const indexedChunks = new Gauge({
  name: "indexed_chunks_total",
  help: "Current total chunks stored in pgvector",
  registers: [register],
})

export const ingestionLatency = new Histogram({
  name: "ingestion_latency_seconds",
  help: "Full document ingestion pipeline latency",
  buckets: [0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0],
  registers: [register],
})

export const queueDepth = new Gauge({
  name: "ingestion_queue_depth",
  help: "Current number of jobs waiting in the ingestion queue",
  registers: [register],
})

// ── Rate Limiting Metrics ─────────────────────────────────────────────────

export const rateLimitHits = new Counter({
  name: "rate_limit_hits_total",
  help: "Total requests rejected by rate limiting",
  labelNames: ["endpoint"], // "rag" | "agent" | "upload" | "eval"
  registers: [register],
})

// ── Reranking Metrics ─────────────────────────────────────────────────────

export const rerankLatency = new Histogram({
  name: "rerank_latency_seconds",
  help: "Cross-encoder reranking latency",
  buckets: [0.1, 0.5, 1.0, 2.0, 5.0, 10.0],
  registers: [register],
})

// ── WebSocket Metrics ─────────────────────────────────────────────────────

export const wsConnections = new Gauge({
  name: "websocket_connections_active",
  help: "Currently active WebSocket connections",
  registers: [register],
})

export const wsMessages = new Counter({
  name: "websocket_messages_total",
  help: "Total WebSocket messages processed",
  labelNames: ["type"], // "start" | "ping" | "auth"
  registers: [register],
})

// ── Helper: update queue depth gauge ─────────────────────────────────────
// Call this periodically to keep the gauge current.
export async function updateQueueDepthGauge(depth: number): Promise<void> {
  queueDepth.set(depth)
}
