# Runbook — Gemini outage

Google's Generative Language API is down, rate-limited, or the API key is
invalid/expired.

## Symptoms

- Ingestion jobs fail: log line `Ingestion job failed` /
  `Job: ingestion pipeline failed` with
  `Gemini embedding API error: <status> …`; after 3 attempts (exponential
  backoff from 5s) the job status is `failed` and its document/chunks are
  cleaned up automatically.
- RAG queries and agent turns return **500** `Internal server error`; backend
  logs show `RAG pipeline failed at generation step` or an embedding error
  under `ErrorMiddleware / Unexpected error`.
- WebSocket agent sessions emit an `error` frame with the API error message.
- `rag_invalid_citations_total` and token counters stop increasing.

## Confirm

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs backend | grep -i gemini | tail -20
```

Then check Google's status page and the key's quota/restrictions in AI Studio
(per-minute quotas and IP restrictions are set up in §H.1 of the plan).

## What still consumes budget

The global budget is charged **before** the Gemini call, so an outage keeps
burning units:

| Operation | Units |
| --- | --- |
| upload (gate) + ingestion job | 1 + `ceil(chunks/100)` |
| RAG query / rerank query | 1 |
| agent turn (HTTP or WS) | 5 |
| eval | 3 |

Watch `rag_global_budget_used` (Prometheus, requires `METRICS_TOKEN`). An
outage that lasts all day can still exhaust `GLOBAL_DAILY_LLM_CALLS_MAX`.

## Actions

1. No code or config change is needed — the pipeline already fails safely and
   cleans up partial documents.
2. Tell users uploads/queries are failing upstream; failed uploads must be
   re-run after recovery (failed jobs are not retried automatically).
3. If the key itself is the problem (400 `API key not valid`), rotate it per
   §H.1 and update `.env.production`, then
   `docker compose --env-file .env.production -f docker-compose.prod.yml up -d backend`.
4. After recovery, run `./scripts/smoke.sh https://<domain>` (real Gemini
   calls — check the budget first).
