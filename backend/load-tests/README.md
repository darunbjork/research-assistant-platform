# Load Testing — Research Assistant Platform

## Prerequisites

1. Backend running: `npm run dev`
2. Grafana running: `npm run monitoring:up`
3. Test user created: `npm run loadtest:setup`

## Running Tests (in order)

```bash
# 1. Set up the test user and ingest test document
npm run loadtest:setup

# 2. Baseline — establishes healthy P95 latency
npm run loadtest:baseline

# 3. Ramp-up — find the breakpoint (watch Grafana!)
# Open http://localhost:3000 BEFORE running this
npm run loadtest:ramp

# 4. Cache warming — measure cache effectiveness
npm run loadtest:cache

# 5. Spike — test graceful degradation
npm run loadtest:spike

# 6. Sustained — detect memory leaks (10 minutes)
npm run loadtest:sustained

# 7. Analyze the ramp-up results
npm run loadtest:analyze load-tests/reports/ramp.json
```

## What to Watch in Grafana

| Artillery Phase       | Grafana Panel to Watch                        |
|-----------------------|-----------------------------------------------|
| Warm-up               | "System Health" — all green?                  |
| Ramp 5→20 users       | "Retrieval Latency P95" — when does it spike? |
| Ramp 20→50 users      | "Active Agent Sessions" — growing linearly?   |
| Spike                 | "Rate Limit Hits" — 429s appear?              |
| Sustained             | "Node.js Memory" — flat or growing?           |
| After cache warming   | "Embedding Cache Hit Rate" — jumps to 80%+?   |

## Interpreting Results

| P95 Latency | Assessment          | Action                              |
|-------------|---------------------|-------------------------------------|
| < 500ms     | Excellent           | None                                |
| 500ms–1s    | Good                | Monitor in production               |
| 1s–2s       | Acceptable          | Consider caching strategy           |
| 2s–5s       | Slow                | Add timeout + graceful degradation  |
| > 5s        | Unacceptable        | Identify and fix bottleneck stage   |

## Finding Bottlenecks

Run each scenario and compare P95:

1. Basic health check P95 = 5ms   → Server is alive
2. Document list P95 = 50ms       → Database is fast
3. RAG query (cache hit) P95 = 1.5s  → Embedding saves 150ms
4. RAG query (cache miss) P95 = 2s   → Embedding adds 150ms
5. Agent chat P95 = 5s              → 3-5 Gemini calls stacking
6. Reranked RAG P95 = 4s           → Reranker adds ~1.5s

Bottleneck = the stage where P95 jumps the most.
