# Runbook — "Daily capacity reached" (global budget tripped)

## Symptoms

Every money-spending endpoint answers with:

```json
{ "success": false, "error": "Daily capacity reached, try again tomorrow" }
```

- `POST /api/v1/documents/upload` → **503** (its HTTP budget gate; note
  `POST /documents/ingest` has no HTTP gate — the queued job's own budget
  check fails instead and the job ends `failed` after 3 attempts)
- `POST /api/v1/rag/query`, `/query-with-rerank` → **503**
- `POST /api/v1/agent/chat` → **503**; WS agent sessions receive an `error`
  frame with `code: "CAPACITY_REACHED"`
- eval endpoints → **503**
- queued ingestion jobs throw the same message and end `failed` after 3
  attempts

## Mechanism

`consumeGlobalBudget()` increments `budget:llm:<YYYY-MM-DD UTC>` in Redis
(TTL 48h so yesterday's counter stays inspectable) and refuses once the
counter exceeds `GLOBAL_DAILY_LLM_CALLS_MAX` (default **2000**, set in
`.env.production`). It resets at **UTC midnight**.

**It also fails closed when Redis is unreachable** — a Redis outage produces
the *identical* message. Check `docker compose … ps redis` and
`docs/runbooks/redis-down.md` first.

## Inspect

```bash
# Units used today (UTC):
docker compose --env-file .env.production -f docker-compose.prod.yml exec redis \
  redis-cli GET "budget:llm:$(date -u +%F)"

# Or via Prometheus (METRICS_TOKEN required):
curl -H "Authorization: Bearer $METRICS_TOKEN" http://<backend>/metrics | grep rag_global_budget_used
```

## Choices

1. **Wait for UTC rollover** — nothing to do.
2. **Raise the cap:** edit `GLOBAL_DAILY_LLM_CALLS_MAX` in `.env.production`,
   then `docker compose --env-file .env.production -f docker-compose.prod.yml up -d backend`.
3. **Reset today's counter** (spend-protection override — only consciously):
   ```bash
   docker compose --env-file .env.production -f docker-compose.prod.yml exec redis \
     redis-cli DEL "budget:llm:$(date -u +%F)"
   ```

Before raising or resetting, check the real bill in Google AI Studio — the
cap exists to stop abuse (per-user limits alone cannot bound a multi-account
client; see `docs/adr/0003-rate-limits-fail-closed-for-paid-ops.md`).
