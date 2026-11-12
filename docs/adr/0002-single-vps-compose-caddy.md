# ADR 0002 — Single VPS with Docker Compose and Caddy

**Status:** accepted (Phase 5, commits `21733f5`, `2a7b430`, `03b2ca9`)

## Context

The platform has to be deployable by one person on one inexpensive Linux box.
Kubernetes, PaaS (Railway etc.) and managed databases are explicitly out of
scope for this plan (`docs/DEPLOY_READY_PLAN.md`). TLS certificates and
reverse-proxy routing must not be hand-maintained.

## Decision

- One file, `docker-compose.prod.yml`: `postgres` (pgvector) and `redis` are
  **internal-only** (no published ports), a one-shot `migrate` job runs
  `prisma migrate deploy`, `backend` (multi-stage image, non-root, HEALTHCHECK
  on `/health`) waits for both, and `web` runs **Caddy** on 80/443.
- Caddy serves the built SPA, proxies `/api/*`, `/ws/*`, `/health` to
  `backend:3001`, obtains certificates automatically from `DOMAIN`, and does
  **not** route `/metrics` (defence in depth with `METRICS_TOKEN`).
- Runtime config comes from `.env.production` (gitignored; template
  `.env.production.example`); secrets are never committed.
- Graceful shutdown: SIGTERM → flag (`/health` 503) → close HTTP/WS → abort
  agents → close queue → disconnect DB/Redis/tracing → `exit(0)`, with a 25s
  fallback under compose's `stop_grace_period: 30s` (ADR/task 5.5).

## Consequences

- Deploy is `git pull && docker compose … up -d --build`; costs one VPS.
- Single point of failure: mitigated by the nightly `pg_dump` cron and
  `docs/runbooks/restore.md`, not by HA.
- Zero-downtime deploys are not possible; containers restart in place and
  browsers/WS clients reconnect.
- Caddy and helmet both emit CSP headers on proxied responses (duplicate,
  harmless).

## Revisit when

- Traffic or availability needs exceed one box, or
- multiple backend replicas are required (WebSocket affinity then matters) —
  at that point move to a managed Postgres/Redis plus an orchestrator, and
  keep Caddy (or equivalent) as edge.
