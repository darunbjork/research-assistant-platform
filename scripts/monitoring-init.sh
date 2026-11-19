#!/usr/bin/env bash
# scripts/monitoring-init.sh
# Prepares secrets for docker-compose.monitoring.yml. Safe to re-run.
#
#   1. Copies METRICS_TOKEN from backend/.env into monitoring/secrets/metrics_token
#      (an empty file when the token is unset: the backend then leaves /metrics open).
#   2. Makes sure GRAFANA_ADMIN_PASSWORD is set: if it's neither exported nor in the
#      root .env, generates one and appends it to the root .env (gitignored).
#
# Usage: ./scripts/monitoring-init.sh && docker compose -f docker-compose.monitoring.yml up -d
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_ENV="$ROOT/backend/.env"
ROOT_ENV="$ROOT/.env"
SECRETS_DIR="$ROOT/monitoring/secrets"
TOKEN_FILE="$SECRETS_DIR/metrics_token"

umask 077
mkdir -p "$SECRETS_DIR"

# Reads KEY from a dotenv file: last uncommented assignment wins, optional
# "export " prefix, surrounding single or double quotes stripped.
read_env_value() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*//p" "$file" \
    | tail -n 1 \
    | sed -E 's/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

# ── 1. Metrics token ────────────────────────────────────────────────────────
token="$(read_env_value METRICS_TOKEN "$BACKEND_ENV")"
printf '%s' "$token" > "$TOKEN_FILE"
# Prometheus runs as "nobody" in the container and must be able to read the
# bind-mounted file; the 700 directory still keeps other host users out.
chmod 644 "$TOKEN_FILE"
if [[ -n "$token" ]]; then
  echo "✓ metrics token: copied METRICS_TOKEN from backend/.env"
else
  echo "✓ metrics token: METRICS_TOKEN not set, wrote an empty file (/metrics is open in dev)"
fi

# ── 2. Grafana admin password ───────────────────────────────────────────────
if [[ -n "${GRAFANA_ADMIN_PASSWORD:-}" ]]; then
  echo "✓ Grafana password: using GRAFANA_ADMIN_PASSWORD from the environment"
elif [[ -n "$(read_env_value GRAFANA_ADMIN_PASSWORD "$ROOT_ENV")" ]]; then
  echo "✓ Grafana password: already set in .env"
else
  password="$(openssl rand -hex 16)"
  printf '\n# Grafana admin password for docker-compose.monitoring.yml\nGRAFANA_ADMIN_PASSWORD=%s\n' "$password" >> "$ROOT_ENV"
  echo "✓ Grafana password: generated and saved to .env as GRAFANA_ADMIN_PASSWORD"
  echo "  Log in to http://localhost:3000 as admin / $password"
fi
