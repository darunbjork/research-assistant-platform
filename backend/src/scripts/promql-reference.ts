/* eslint-disable no-console */
// backend/src/scripts/promql-reference.ts
// A reference file showing every PromQL query used in the dashboards.
// Run this to print all queries with explanations.
//
// Usage: npx ts-node src/scripts/promql-reference.ts

const QUERIES = [
  {
    panel: "RAG Requests / minute",
    query: `rate(rag_requests_total[5m]) * 60`,
    explanation: [
      "rate(): computes per-second rate of increase over 5m window",
      "× 60:   converts to per-minute rate",
      "5m:     5-minute rolling average smooths out spikes",
    ],
  },
  {
    panel: "Error Rate",
    query: `rate(rag_requests_total{status="error"}[5m]) / (rate(rag_requests_total[5m]) + 0.0001)`,
    explanation: [
      '{status="error"}: filter to only error requests',
      "Divide errors by total to get ratio (0-1)",
      "+ 0.0001: prevent divide-by-zero when no requests",
    ],
  },
  {
    panel: "Embedding Cache Hit Rate",
    query: `rate(embedding_cache_hits_total[5m]) / (rate(embedding_cache_hits_total[5m]) + rate(embedding_cache_misses_total[5m]) + 0.0001)`,
    explanation: [
      "hits / (hits + misses) = hit rate",
      "A hit rate > 0.6 means most embeddings are served from Redis",
      "Low hit rate → consider increasing TTL or check if queries are diverse",
    ],
  },
  {
    panel: "Retrieval Latency P95",
    query: `histogram_quantile(0.95, rate(retrieval_latency_seconds_bucket[5m]))`,
    explanation: [
      "histogram_quantile(0.95, ...): 95th percentile",
      "95% of requests complete faster than this value",
      "_bucket: suffix for histogram bucket metrics",
      "rate(...[5m]): rolling 5-minute rate to smooth noise",
    ],
  },
  {
    panel: "RAG Triad Faithfulness",
    query: `histogram_quantile(0.50, rate(rag_triad_score_bucket{dimension="faithfulness"}[10m]))`,
    explanation: [
      "0.50 = median (P50) faithfulness score",
      "10m window: wider window for quality metrics (evaluated less frequently)",
      "dimension label: filters to one RAG Triad dimension",
      "Below 0.7: alert fires (see monitoring/alerts/rag-alerts.yml)",
    ],
  },
  {
    panel: "Node.js Memory",
    query: `process_heap_bytes`,
    explanation: [
      "Collected automatically by prom-client's collectDefaultMetrics()",
      "process_heap_bytes: Node.js V8 heap memory",
      "process_resident_memory_bytes: total RAM used by the process",
      "Growing unbounded heap = memory leak",
    ],
  },
]

function main(): void {
  console.log("=".repeat(65))
  console.log("PROMQL REFERENCE — Research Assistant Dashboard")
  console.log("=".repeat(65))
  console.log()

  QUERIES.forEach((q, i) => {
    console.log(`${i + 1}. ${q.panel}`)
    console.log(`   Query: ${q.query}`)
    console.log(`   Why:`)
    q.explanation.forEach(e => {
      console.log(`     → ${e}`)
    })
    console.log()
  })

  console.log("KEY PROMQL FUNCTIONS:")
  console.log("  rate(metric[5m])            — per-second rate of change")
  console.log("  increase(metric[1h])         — total increase over 1 hour")
  console.log("  histogram_quantile(0.95, ...) — compute a percentile")
  console.log("  avg_over_time(metric[10m])   — rolling average")
  console.log("  topk(5, metric)              — top 5 time series by value")
  console.log()
}

main()
