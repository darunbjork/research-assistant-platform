/* eslint-disable no-console */
// backend/src/scripts/seed-metrics.ts
// Seeds Prometheus metrics with realistic values for dashboard testing.
// Run this to populate the dashboard with sample data before real traffic.
//
// Usage: npx ts-node src/scripts/seed-metrics.ts

import {
  ragRequests,
  retrievalLatency,
  generationLatency,
  embeddingLatency,
  embeddingCacheHits,
  embeddingCacheMisses,
  searchCacheHits,
  searchCacheMisses,
  agentIterations,
  activeAgentSessions,
  ragTriadScores,
  indexedDocuments,
  indexedChunks,
  ingestionLatency,
  wsConnections,
  rerankLatency,
} from "../utils/metrics"

// Simulate realistic traffic patterns over time
async function seedMetrics(): Promise<void> {
  console.log("Seeding Prometheus metrics with realistic sample data...")
  console.log("Run 'npm run dev' and start Grafana to see the dashboard.")
  console.log()

  // ── Simulate 50 queries ───────────────────────────────────────────────
  for (let i = 0; i < 50; i++) {
    // RAG requests (90% success rate)
    const status = Math.random() > 0.1 ? "success" : "error"
    ragRequests.inc({ status })

    // Retrieval latency: 50-400ms (hybrid search)
    const retrievalMs = 50 + Math.random() * 350
    retrievalLatency.observe({ strategy: "hybrid" }, retrievalMs / 1000)

    // Generation latency: 800ms-3000ms
    const generationMs = 800 + Math.random() * 2200
    generationLatency.observe(generationMs / 1000)

    // Embedding latency: 5ms (cache hit) or 100-200ms (miss)
    const cacheHit = Math.random() > 0.4 // 60% cache hit rate
    if (cacheHit) {
      embeddingLatency.observe({ cache_hit: "true" }, 0.005)
      embeddingCacheHits.inc()
    } else {
      embeddingLatency.observe({ cache_hit: "false" }, 0.1 + Math.random() * 0.1)
      embeddingCacheMisses.inc()
    }

    // Search cache
    if (Math.random() > 0.6) {
      searchCacheHits.inc()
    } else {
      searchCacheMisses.inc()
    }

    // Reranking latency: 500ms-1500ms
    rerankLatency.observe(0.5 + Math.random() * 1.0)

    // RAG Triad scores (realistic distributions)
    ragTriadScores.observe(
      { dimension: "context_relevance" },
      0.65 + Math.random() * 0.3 // 0.65-0.95
    )
    ragTriadScores.observe(
      { dimension: "faithfulness" },
      0.7 + Math.random() * 0.25 // 0.70-0.95
    )
    ragTriadScores.observe(
      { dimension: "answer_relevance" },
      0.6 + Math.random() * 0.35 // 0.60-0.95
    )

    // Small delay to spread timestamps
    await new Promise(r => setTimeout(r, 50))
  }

  // ── Agent sessions ────────────────────────────────────────────────────
  for (let i = 0; i < 20; i++) {
    // Iterations: 1-4 per session
    const iterations = Math.floor(1 + Math.random() * 3)
    for (let j = 0; j < iterations; j++) {
      agentIterations.inc({ tool: "rag_search" })
    }
    if (Math.random() > 0.7) {
      agentIterations.inc({ tool: "calculator" })
    }
  }

  // ── Document ingestion ────────────────────────────────────────────────
  for (let i = 0; i < 10; i++) {
    indexedDocuments.inc()
    ingestionLatency.observe(2 + Math.random() * 5)
  }

  // ── Gauges ────────────────────────────────────────────────────────────
  activeAgentSessions.set(Math.floor(Math.random() * 3))
  indexedChunks.set(400 + Math.floor(Math.random() * 200))
  wsConnections.set(Math.floor(Math.random() * 5))

  console.log("✅ Metrics seeded.")
  console.log()
  console.log("Next steps:")
  console.log("  1. Start the backend:  npm run dev")
  console.log("  2. Start Grafana:      docker compose -f docker-compose.monitoring.yml up -d")
  console.log("  3. Open Grafana:       http://localhost:3000  (admin/admin)")
  console.log("  4. Find the dashboard: 'Research Assistant — RAG Overview'")
  console.log()
  console.log("The /metrics endpoint now has data — Prometheus will scrape it")
  console.log("within 15 seconds and Grafana will render the panels.")
}

seedMetrics().catch(console.error)
