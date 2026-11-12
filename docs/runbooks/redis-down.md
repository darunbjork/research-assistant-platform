# Runbook — Redis down

## Symptoms

- `GET /health` → **503**, body
  `"services": { …, "redis": "error" }`, top-level `status: "degraded"` →
  the `backend` container goes **unhealthy** in `docker compose ps` (Caddy
  keeps proxying; only the health signal degrades).
- Money-spending endpoints return **429** with `Retry-After: 60` (rate
  limiters fail closed) or **503** `Daily capacity reached…` (budget fails
  closed) — the capacity message here is *misleading*, it does not mean the
  budget is spent.
- Light reads (list documents, poll jobs) and **login** still work (their
  limiters fail open); **register** is refused (fail closed).
- Uploads fail while enqueueing (Bull cannot reach Redis); job polling may
  return 500.
- Embedding/search caches are unreachable — irrelevant while queries are
  being refused anyway.

## Diagnose

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps redis
docker compose --env-file .env.production -f docker-compose.prod.yml logs redis | tail -50
docker compose --env-file .env.production -f docker-compose.prod.yml exec redis redis-cli ping   # expect PONG
df -h                                                                                            # disk full?
```

Typical causes: disk full, OOM kill, restart loop after a host reboot.

## Recover

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d redis   # or: … restart redis

# Watch the backend reconnect (ioredis retries by itself — no backend restart needed):
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f backend | grep -i redis
curl -fsS https://<domain>/health    # expect 200, "redis": "ok"
```

Once healthy, the limiters and budget resume from the existing keys
(`redisdata` is a named volume, keys and TTLs survive a restart).

## If the volume was lost (data on disk gone)

- Rate-limit windows and the **global budget counter reset** — the spend cap
  starts the day over; verify the real Gemini spend before assuming you are
  protected.
- Embedding/search caches are cold → first queries re-embed (small cost,
  bounded by the budget).
- Nothing else is at risk: Postgres is a separate volume; JWT auth is
  stateless.

## If Redis keeps dying

Repeated outages during paid traffic are effectively a capacity outage
(budget and paid limiters fail closed) — see
`docs/adr/0003-rate-limits-fail-closed-for-paid-ops.md` for why, and treat a
durable/managed Redis as the ADR's revisit trigger.
