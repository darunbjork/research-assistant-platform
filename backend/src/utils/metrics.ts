// Prometheus metrics — numeric measurements exposed at /metrics.
// TODO: Grafana, Datadog, and other tools scrape this endpoint every 15-30 seconds
// and build dashboards and alerts from the numbers.
//
// TODO: THREE METRIC TYPES:
//
// * Counter   → only goes UP. Use for "how many times did X happen?"
//             Examples: requests, errors, tokens consumed, API calls
//             Never resets (unless process restarts).
//
// * Histogram → measures DISTRIBUTIONS. Use for "how long did X take?"
//             Stores counts in "buckets" (how many requests took < 100ms, < 200ms, etc.)
//             This lets Grafana show p50/p95/p99 latency — much more useful than average.
//
// * Gauge     → goes UP and DOWN. Use for "what is the current value of X?"
//             Examples: active sessions, items in a queue, memory usage

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client"

// Custom registry — keeps our metrics separate from any library defaults.
// Prevents naming conflicts if you add other Prometheus libraries later.
export const registry = new Registry()

// * Collect Node.js built-in metrics: CPU usage, memory heap, event loop lag, etc.
// These appear automatically at /metrics — useful for infrastructure monitoring.
collectDefaultMetrics({ register: registry })

// ── Embedding Metrics ─────────────────────────────────────────────────────

// How many embedding API calls have been made?
// labelNames lets you split by outcome: status="success" vs status="error"
export const embeddingRequests = new Counter({
  name: "rag_embedding_requests_total",
  help: "Total number of embedding API calls made to Gemini",
  labelNames: ["status"] as const, // "success" | "error" | "cache_hit"
  registers: [registry],
})

// How long do embedding calls take? (milliseconds)
// Buckets: we care about calls under 100ms (great), under 1000ms (ok), over 5000ms (bad)
export const embeddingLatency = new Histogram({
  name: "rag_embedding_latency_ms",
  help: "Gemini embedding API call latency in milliseconds",
  buckets: [50, 100, 200, 500, 1000, 2000, 5000],
  registers: [registry],
})

// ── Retrieval Metrics ─────────────────────────────────────────────────────

export const retrievalRequests = new Counter({
  name: "rag_retrieval_requests_total",
  help: "Total retrieval pipeline executions",
  labelNames: ["strategy"] as const, // "vector" | "keyword" | "hybrid"
  registers: [registry],
})

export const retrievalLatency = new Histogram({
  name: "rag_retrieval_latency_ms",
  help: "Full retrieval pipeline latency in milliseconds",
  buckets: [10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
})

// ── Generation Metrics ────────────────────────────────────────────────────

export const generationRequests = new Counter({
  name: "rag_generation_requests_total",
  help: "Total LLM generation calls",
  labelNames: ["status"] as const,
  registers: [registry],
})

export const generationLatency = new Histogram({
  name: "rag_generation_latency_ms",
  help: "LLM generation latency in milliseconds",
  // Generation is slower than retrieval — buckets reflect that
  buckets: [500, 1000, 2000, 3000, 5000, 10000, 20000],
  registers: [registry],
})

// ── Token Cost Metrics ────────────────────────────────────────────────────
// Track every token consumed — tokens cost money.
// This tells you exactly what each operation type costs over time.

export const tokenCost = new Counter({
  name: "rag_tokens_consumed_total",
  help: "Total tokens consumed across all LLM API calls",
  labelNames: ["operation"] as const, // "embedding" | "generation" | "agent_think"
  registers: [registry],
})

// ── Agent Metrics ─────────────────────────────────────────────────────────

export const agentIterations = new Counter({
  name: "rag_agent_iterations_total",
  help: "Total ReAct loop iterations across all agent sessions",
  labelNames: ["tool"] as const, // which tool was called each iteration
  registers: [registry],
})

export const agentSessionDuration = new Histogram({
  name: "rag_agent_session_duration_ms",
  help: "Total agent session duration from first message to final answer",
  buckets: [1000, 2000, 5000, 10000, 20000, 30000, 60000],
  registers: [registry],
})

// ── RAG Quality Metrics ───────────────────────────────────────────────────
// These record the RAG Triad scores (Day 18).
// labelNames: dimension = "context_relevance" | "faithfulness" | "answer_relevance"

export const ragTriadScores = new Histogram({
  name: "rag_triad_score",
  help: "RAG Triad evaluation scores (0 to 1, higher is better)",
  labelNames: ["dimension"] as const,
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [registry],
})

// ── System State Metrics ──────────────────────────────────────────────────

// How many users are actively in a chat session right now?
export const activeAgentSessions = new Gauge({
  name: "rag_active_agent_sessions",
  help: "Number of currently active agent sessions (real-time)",
  registers: [registry],
})

// How many chunks are indexed in pgvector right now?
// Important for capacity planning — pgvector performance degrades above ~1M chunks without indexing.
export const indexedChunks = new Gauge({
  name: "rag_indexed_chunks_total",
  help: "Total document chunks currently indexed in pgvector",
  registers: [registry],
})

// How many documents have been ingested?
export const indexedDocuments = new Gauge({
  name: "rag_indexed_documents_total",
  help: "Total documents currently in the system",
  registers: [registry],
})

// ── HTTP Metrics ──────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration in milliseconds",
  labelNames: ["method", "path", "status"] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [registry],
})

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests received",
  labelNames: ["method", "path", "status"] as const,
  registers: [registry],
})
