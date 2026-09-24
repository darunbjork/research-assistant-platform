/* eslint-disable no-console */

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

async function seedMetrics(): Promise<void> {
  console.log("Seeding Prometheus metrics with realistic sample data...")
  console.log("Run 'npm run dev' and start Grafana to see the dashboard.")
  console.log()

  for (let i = 0; i < 50; i++) {
    const status = Math.random() > 0.1 ? "success" : "error"
    ragRequests.inc({ status })

    const retrievalMs = 50 + Math.random() * 350
    retrievalLatency.observe({ strategy: "hybrid" }, retrievalMs / 1000)

    const generationMs = 800 + Math.random() * 2200
    generationLatency.observe(generationMs / 1000)

    const cacheHit = Math.random() > 0.4
    if (cacheHit) {
      embeddingLatency.observe({ cache_hit: "true" }, 0.005)
      embeddingCacheHits.inc()
    } else {
      embeddingLatency.observe({ cache_hit: "false" }, 0.1 + Math.random() * 0.1)
      embeddingCacheMisses.inc()
    }

    if (Math.random() > 0.6) {
      searchCacheHits.inc()
    } else {
      searchCacheMisses.inc()
    }

    rerankLatency.observe(0.5 + Math.random() * 1.0)

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

    await new Promise(r => setTimeout(r, 50))
  }

  for (let i = 0; i < 20; i++) {
    const iterations = Math.floor(1 + Math.random() * 3)
    for (let j = 0; j < iterations; j++) {
      agentIterations.inc({ tool: "rag_search" })
    }
    if (Math.random() > 0.7) {
      agentIterations.inc({ tool: "calculator" })
    }
  }

  for (let i = 0; i < 10; i++) {
    indexedDocuments.inc()
    ingestionLatency.observe(2 + Math.random() * 5)
  }

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
