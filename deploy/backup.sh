#!/usr/bin/env bash
#
# Task 5.7 — nightly Postgres backup (custom pg_dump format).
#
# Usage:  deploy/backup.sh
# Env:    ENV_FILE (default .env.production), COMPOSE_FILE (default
#         docker-compose.prod.yml), BACKUP_DIR (default /var/backups/rap),
#         KEEP (default 7 dumps).
#
# Installs as a cron job — see the commented crontab line at the bottom.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/rap}"
KEEP="${KEEP:-7}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "backup: env file $ENV_FILE not found" >&2
  exit 1
fi

POSTGRES_USER="$(sed -n 's/^POSTGRES_USER=//p' "$ENV_FILE" | tail -1 | tr -d "\"'"
  )"
POSTGRES_DB="$(sed -n 's/^POSTGRES_DB=//p' "$ENV_FILE" | tail -1 | tr -d "\"'")"
if [[ -z "$POSTGRES_USER" || -z "$POSTGRES_DB" ]]; then
  echo "backup: POSTGRES_USER / POSTGRES_DB missing from $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/rap-$STAMP.dump"
TMP="$OUT.tmp"
trap 'rm -f "$TMP"' EXIT

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
  exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$TMP"
mv "$TMP" "$OUT"

# Keep the newest $KEEP dumps; delete older ones.
shopt -s nullglob
dumps=("$BACKUP_DIR"/rap-*.dump)
if ((${#dumps[@]} > KEEP)); then
  # ls -t sorts newest first; skip the first $KEEP.
  while IFS= read -r old; do
    rm -f "$old"
  done < <(ls -1t "${dumps[@]}" | tail -n +$((KEEP + 1)))
fi

echo "backup: wrote $OUT"

# crontab (root), nightly at 03:15 UTC — keep the newest 7 dumps:
# 15 3 * * * /srv/research-assistant-platform/deploy/backup.sh >> /var/log/rap-backup.log 2>&1
