// load-tests/scripts/analyze-results.ts
// Reads Artillery JSON output and produces a bottleneck analysis report.
//
// Usage: npx ts-node load-tests/scripts/analyze-results.ts 
//          load-tests/reports/latest.json

import fs   from "fs"
import path from "path"

// ── Artillery JSON Report Shape ───────────────────────────────────────────
interface ArtilleryAggregate {
  latency: {
    min:    number
    max:    number
    median: number
    p95:    number
    p99:    number
  }
  rps: {
    count: number
    mean:  number
  }
  errors:    Record<string, number>
  codes:     Record<string, number>
  scenarios: {
    created:   number
    completed: number
    failed:    number
  }
  requestsCompleted: number
}

interface ArtilleryReport {
  aggregate:    ArtilleryAggregate
  intermediate: ArtilleryAggregate[]
  config:       { target: string; phases: Array<{ name: string }> }
}

// ── Analysis Functions ────────────────────────────────────────────────────

function loadReport(filePath: string): ArtilleryReport {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Report not found: ${filePath}`)
    console.error("   Run: artillery run load-tests/scenarios/01-baseline.yml --output load-tests/reports/latest.json")
    process.exit(1)
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ArtilleryReport
}

function getGrade(p95Ms: number): string {
  if (p95Ms < 500)  return "✅ Excellent  (< 500ms)"
  if (p95Ms < 1000) return "✅ Good       (< 1s)"
  if (p95Ms < 2000) return "⚠️  Acceptable (< 2s)"
  if (p95Ms < 5000) return "⚠️  Slow       (< 5s)"
  return                    "❌ Too slow   (> 5s)"
}

function getErrorGrade(errorRate: number): string {
  if (errorRate < 0.001) return "✅ Excellent (< 0.1%)"
  if (errorRate < 0.01)  return "✅ Good      (< 1%)"
  if (errorRate < 0.05)  return "⚠️  Warning   (< 5%)"
  return                        "❌ Critical  (> 5%)"
}

function identifyBottleneck(
  p95Ms:     number,
  errorRate: number,
  codes:     Record<string, number>
): string {
  const total   = Object.values(codes).reduce((a, b) => a + b, 0)
  const rate429 = (codes["429"] ?? 0) / (total || 1)
  const rate5xx = Object.entries(codes)
    .filter(([code]) => code.startsWith("5"))
    .reduce((sum, [, count]) => sum + count, 0) / (total || 1)

  if (rate429 > 0.2) {
    return "🚦 RATE LIMITING — More than 20% requests hit the rate limit.
" +
           "   → Increase limits for load tests OR reduce Artillery arrival rate.
" +
           "   → In production, this is correct behaviour protecting the system."
  }

  if (rate5xx > 0.05) {
    return "💥 SERVER ERRORS — More than 5% of requests returned 5xx.
" +
           "   → Check backend logs immediately.
" +
           "   → Likely cause: connection pool exhaustion or OOM."
  }

  if (p95Ms > 5000) {
    return "⏱ GENERATION BOTTLENECK — P95 > 5s suggests Gemini API is slow.
" +
           "   → Add a 4s timeout to generation with graceful fallback.
" +
           "   → Consider caching generated answers for identical queries.
" +
           "   → Check Gemini API status page for incidents."
  }

  if (p95Ms > 2000) {
    return "⏱ RETRIEVAL OR RERANKING BOTTLENECK — P95 2-5s.
" +
           "   → Disable reranker temporarily and retest: if P95 drops, reranker is the cause.
" +
           "   → Check pgvector IVFFlat index — may need higher nlist value under load.
" +
           "   → Check Redis connection pool: search cache may not be serving hits."
  }

  if (p95Ms > 1000) {
    return "⚡ EMBEDDING BOTTLENECK — P95 1-2s.
" +
           "   → Check embedding cache hit rate (GET /documents/cache/stats).
" +
           "   → If cache hit rate < 50%: queries too diverse or TTL too short.
" +
           "   → Consider pre-warming cache for common queries."
  }

  return "✅ NO BOTTLENECK DETECTED — System performing well under this load."
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

// ── Main Analysis ─────────────────────────────────────────────────────────

function analyze(reportPath: string): void {
  const report = loadReport(reportPath)
  const agg    = report.aggregate

  const totalRequests = agg.requestsCompleted
  const totalErrors   = Object.values(agg.errors ?? {}).reduce((a, b) => a + b, 0)
  const errorRate     = totalRequests > 0 ? totalErrors / totalRequests : 0

  const codes  = agg.codes ?? {}
  const rate429 = ((codes["429"] ?? 0) / (totalRequests || 1)) * 100

  console.log()
  console.log("=".repeat(65))
  console.log("ARTILLERY LOAD TEST RESULTS — BOTTLENECK ANALYSIS")
  console.log("=".repeat(65))
  console.log()

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("SUMMARY:")
  console.log(`  Requests completed: ${totalRequests.toLocaleString()}`)
  console.log(`  RPS (mean):         ${agg.rps.mean.toFixed(1)}`)
  console.log(`  Scenarios created:  ${agg.scenarios.created}`)
  console.log(`  Scenarios failed:   ${agg.scenarios.failed}`)
  console.log()

  // ── Latency ───────────────────────────────────────────────────────────
  console.log("LATENCY:")
  console.log(`  Minimum:  ${formatLatency(agg.latency.min)}`)
  console.log(`  Median:   ${formatLatency(agg.latency.median)}`)
  console.log(`  P95:      ${formatLatency(agg.latency.p95)}   ${getGrade(agg.latency.p95)}`)
  console.log(`  P99:      ${formatLatency(agg.latency.p99)}`)
  console.log(`  Maximum:  ${formatLatency(agg.latency.max)}`)
  console.log()

  // ── Error analysis ────────────────────────────────────────────────────
  console.log("RESPONSE CODES:")
  Object.entries(codes)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .forEach(([code, count]) => {
      const pct = ((count / totalRequests) * 100).toFixed(1)
      const icon = code.startsWith("2") ? "✅" : code === "429" ? "🚦" : "❌"
      console.log(`  ${icon} ${code}: ${count.toLocaleString()} (${pct}%)`)
    })
  console.log()

  console.log("ERROR RATE:")
  console.log(`  Rate: ${(errorRate * 100).toFixed(2)}%   ${getErrorGrade(errorRate)}`)
  console.log(`  429s: ${rate429.toFixed(1)}% of requests hit rate limits`)
  console.log()

  // ── Bottleneck identification ──────────────────────────────────────────
  console.log("BOTTLENECK ANALYSIS:")
  console.log()
  const bottleneck = identifyBottleneck(agg.latency.p95, errorRate, codes)
  bottleneck.split("
").forEach(line => console.log(`  ${line}`))
  console.log()

  // ── Intermediate results (latency over time) ──────────────────────────
  if (report.intermediate && report.intermediate.length > 0) {
    console.log("LATENCY OVER TIME (P95 per interval):")
    report.intermediate.forEach((interval, i) => {
      const bar = "█".repeat(Math.min(20, Math.round(interval.latency.p95 / 500)))
      console.log(`  Interval ${String(i + 1).padStart(2)}: ${bar} ${formatLatency(interval.latency.p95)}`)
    })
    console.log()

    // Check for drift (increasing latency over time)
    const first = report.intermediate[0]?.latency.p95 ?? 0
    const last  = report.intermediate[report.intermediate.length - 1]?.latency.p95 ?? 0
    const drift = ((last - first) / (first || 1)) * 100

    if (drift > 50) {
      console.log(`  ⚠️  LATENCY DRIFT: P95 increased by ${drift.toFixed(0)}% during the test.`)
      console.log("     Possible causes: memory leak, connection pool exhaustion, cache thrashing.")
    } else {
      console.log(`  ✅ LATENCY STABLE: P95 drift = ${drift.toFixed(0)}% (below 50% threshold).`)
    }
    console.log()
  }

  // ── Recommendations ───────────────────────────────────────────────────
  console.log("RECOMMENDATIONS:")

  const recs: string[] = []

  if (agg.latency.p95 > 2000) {
    recs.push("Add 4-second timeout to generation with fallback: 'Based on the available context, I found partial information...'")
  }

  if (rate429 > 10) {
    recs.push("Increase rate limits for your own load testing, but keep production limits tight.")
  }

  if (agg.latency.p99 > agg.latency.p95 * 3) {
    recs.push("P99 is 3× P95 — high tail latency. Add circuit breaker to the slowest stage.")
  }

  if (agg.scenarios.failed > 0) {
    recs.push(`${agg.scenarios.failed} scenarios failed (timeout/crash). Check backend logs for 500s.`)
  }

  if (recs.length === 0) {
    console.log("  ✅ System performed well. Consider running the sustained test (05) next.")
  } else {
    recs.forEach((rec, i) => console.log(`  ${i + 1}. ${rec}`))
  }

  console.log()
  console.log("=".repeat(65))
  console.log("VIEW DETAILED METRICS:")
  console.log("  Grafana: http://localhost:3000")
  console.log("  Prometheus: http://localhost:9090")
  console.log(`  Raw report: ${reportPath}`)
  console.log("=".repeat(65))
  console.log()
}

// ── Entry Point ───────────────────────────────────────────────────────────
const reportFile = process.argv[2]
  ?? path.join(process.cwd(), "load-tests", "reports", "latest.json")

analyze(reportFile)
