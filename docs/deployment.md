# Deployment Guide — single VPS with Docker Compose and Caddy

This is the supported production deployment (task 6.1). The stack runs from
`docker-compose.prod.yml`: a one-shot Postgres migrate job, the backend, an
internal-only Postgres (`pgvector`) and Redis, and a `web` container that runs
[Caddy](https://caddyserver.com/) as TLS-terminating reverse proxy in front of
the SPA (`/`) and the API (`/api/*`, `/ws/*`, `/health`). `/metrics` is
intentionally **not** proxied.

## Prerequisites

- A Linux VPS (Ubuntu 22.04+), a domain with a DNS **A record** pointing at it
- Docker Engine with the compose plugin (`docker compose version`)
- `curl` and `jq` for the smoke script

## One-time setup (H.2)

```bash
# DNS: A record research.<yourdomain> → VPS IP (wait until dig +short returns it)
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable

git clone https://github.com/darunbjork/research-assistant-platform.git && cd research-assistant-platform
git checkout deploy-ready            # or main after merge

cp .env.production.example .env.production && nano .env.production
```

Fill in at minimum: `DOMAIN`, `POSTGRES_PASSWORD` (long random), `DATABASE_URL`
(password and DB must match the `POSTGRES_*` values), `GEMINI_API_KEY`,
`JWT_SECRET`, `JWT_REFRESH_SECRET` (both ≥ 32 chars, different —
`openssl rand -hex 32` twice), `CORS_ORIGINS=https://research.<yourdomain>`,
`METRICS_TOKEN` (`openssl rand -hex 24`). Caddy obtains its Let's Encrypt
certificate from `DOMAIN` on first start.

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.production -f docker-compose.prod.yml ps
./scripts/smoke.sh https://research.<yourdomain>
```

`migrate` runs `prisma migrate deploy` once and exits; `backend` waits for it
and for healthy Postgres/Redis, then `web` serves the site on 80/443.

Then install the nightly backup cron from `docs/runbooks/restore.md`
(`deploy/backup.sh`, crontab line `15 3 * * *`).

Before the first deploy also complete the human-only steps in
`docs/DEPLOY_READY_PLAN.md` §H.1 (Gemini budget alerts, key rotation,
secrets).

## Updating

```bash
git pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Migrations run automatically by the `migrate` job on each deploy (they are
forward-only). Watch it: `docker compose --env-file .env.production -f docker-compose.prod.yml logs migrate`.

## Reading logs

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f backend
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f web
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f migrate
```

On shutdown, `backend` logs each teardown step; a step failure is logged as
`Shutdown step failed: <step>` and the process still exits 0 (25s fallback
forces exit 1).

## Rolling back

Migrations are **forward-only** — never roll back code across a migration
boundary without a database backup first.

```bash
# 1. Take a backup first (custom pg_dump format, newest kept):
./deploy/backup.sh

# 2. Check out the previous known-good ref and rebuild:
git checkout <previous-tag>
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build

# 3. Verify:
curl -fsS https://<domain>/health && ./scripts/smoke.sh https://<domain>
```

If the deployed code and the current schema no longer match (a migration ran
that the older code does not know), restore the dump taken in step 1 — see
`docs/runbooks/restore.md`.

## Related runbooks

- `docs/runbooks/restore.md` — backups, restore, restore drill
- `docs/runbooks/gemini-outage.md` — Gemini API failures
- `docs/runbooks/capacity-reached.md` — global daily budget tripped
- `docs/runbooks/redis-down.md` — Redis unavailable
