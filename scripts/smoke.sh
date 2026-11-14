#!/usr/bin/env bash
#
# Task 5.6 — end-to-end smoke test for a deployed instance.
#
# Usage:   scripts/smoke.sh BASE_URL
# Example: scripts/smoke.sh https://assistant.example.com
#
# Requires curl and jq. Uses REAL Gemini calls (roughly 3–5 per run) and
# charges the global daily budget — only run it after the human has set the
# budget caps in §H of docs/DEPLOY_READY_PLAN.md.

set -euo pipefail

BASE_URL="${1:-}"
if [[ -z "$BASE_URL" ]]; then
  echo "usage: $0 BASE_URL   (e.g. $0 https://assistant.example.com)" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"

command -v curl >/dev/null 2>&1 || { echo "SMOKE FAIL: curl is required" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "SMOKE FAIL: jq is required" >&2; exit 2; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
BODY="$TMP_DIR/last-response.json"
HTTP_STATUS=""

fail() {
  echo "SMOKE FAIL: $*" >&2
  echo "--- last response (status: ${HTTP_STATUS:-none}) ---" >&2
  cat "$BODY" >&2 2>/dev/null || true
  echo >&2
  exit 1
}

# http METHOD PATH [TOKEN] [extra curl args...]
# Stores the response body in $BODY and the status code in $HTTP_STATUS.
http() {
  local method="$1" path="$2"
  shift 2
  local token=""
  if [[ $# -gt 0 && "$1" != -* ]]; then
    token="$1"
    shift
  fi
  local -a auth=()
  if [[ -n "$token" ]]; then
    auth=(-H "Authorization: Bearer $token")
  fi
  HTTP_STATUS="$(curl -sS --max-time 60 -o "$BODY" -w "%{http_code}" \
    -X "$method" ${auth[@]+"${auth[@]}"} "$@" "${BASE_URL}${path}")" \
    || fail "curl $method $path failed (network error)"
}

json_field() {
  jq -er "$1" "$BODY" || fail "response is missing field $1"
}

echo "smoke: target ${BASE_URL} — real Gemini calls, ~3–5 per run"
echo "1. health"
http GET /health
[[ "$HTTP_STATUS" == "200" ]] || fail "GET /health returned $HTTP_STATUS (expected 200)"

echo "2. register and login users A and B"
RUN_ID="$(date +%s)-${RANDOM}"
EMAIL_A="smoke-a-${RUN_ID}@example.com"
EMAIL_B="smoke-b-${RUN_ID}@example.com"
PASSWORD="Smoke-${RUN_ID}-pass"

http POST /api/v1/auth/register "" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL_A}\",\"password\":\"${PASSWORD}\"}"
[[ "$HTTP_STATUS" == "201" ]] || fail "register A returned $HTTP_STATUS (expected 201)"

http POST /api/v1/auth/register "" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL_B}\",\"password\":\"${PASSWORD}\"}"
[[ "$HTTP_STATUS" == "201" ]] || fail "register B returned $HTTP_STATUS (expected 201)"

http POST /api/v1/auth/login "" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL_A}\",\"password\":\"${PASSWORD}\"}"
[[ "$HTTP_STATUS" == "200" ]] || fail "login A returned $HTTP_STATUS (expected 200)"
TOKEN_A="$(json_field '.data.tokens.accessToken')"
[[ -n "$TOKEN_A" ]] || fail "login A returned no access token"

http POST /api/v1/auth/login "" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL_B}\",\"password\":\"${PASSWORD}\"}"
[[ "$HTTP_STATUS" == "200" ]] || fail "login B returned $HTTP_STATUS (expected 200)"
TOKEN_B="$(json_field '.data.tokens.accessToken')"
[[ -n "$TOKEN_B" ]] || fail "login B returned no access token"

echo "3. upload a .txt as A and poll the job (60s timeout)"
DOC_FILE="$TMP_DIR/smoke.txt"
cat > "$DOC_FILE" <<'EOF'
The SurDal lighthouse was kept by Einar Hovland during the great storm of
1847. Einar Hovland repaired the lamp mechanism himself and the light never
failed. The SurDal lighthouse log records Einar Hovland by name on every
page of the 1847 season.
EOF

http POST /api/v1/documents/upload "$TOKEN_A" \
  -F "file=@${DOC_FILE};type=text/plain"
[[ "$HTTP_STATUS" == "202" ]] || fail "upload returned $HTTP_STATUS (expected 202)"
JOB_ID="$(json_field '.data.jobId')"
[[ -n "$JOB_ID" ]] || fail "upload returned no jobId"

DEADLINE=$((SECONDS + 60))
JOB_STATUS=""
while :; do
  http GET "/api/v1/documents/jobs/${JOB_ID}" "$TOKEN_A"
  [[ "$HTTP_STATUS" == "200" ]] || fail "poll job returned $HTTP_STATUS (expected 200)"
  JOB_STATUS="$(json_field '.data.status')"
  if [[ "$JOB_STATUS" == "completed" ]]; then
    break
  fi
  if [[ "$JOB_STATUS" == "failed" ]]; then
    fail "ingestion job failed: $(jq -c '.data' "$BODY")"
  fi
  if (( SECONDS >= DEADLINE )); then
    fail "job ${JOB_ID} did not complete within 60s (last status: ${JOB_STATUS})"
  fi
  sleep 1
done
DOCUMENT_ID="$(json_field '.data.result.documentId')"
[[ -n "$DOCUMENT_ID" ]] || fail "completed job returned no result.documentId"

echo "4. RAG query as A: citations and no invalid citations"
QUERY="Who kept the SurDal lighthouse during the storm of 1847?"
http POST /api/v1/rag/query "$TOKEN_A" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"${QUERY}\"}"
[[ "$HTTP_STATUS" == "200" ]] || fail "RAG query as A returned $HTTP_STATUS (expected 200)"
CITATIONS_A="$(json_field '.data.citations | length')"
(( CITATIONS_A >= 1 )) || fail "RAG query as A returned ${CITATIONS_A} citations (expected >= 1)"
INVALID_A="$(json_field '.data.invalidCitationCount')"
(( INVALID_A == 0 )) || fail "invalidCitationCount is ${INVALID_A} (expected 0)"

echo "5. B polls A's job: must be 404"
http GET "/api/v1/documents/jobs/${JOB_ID}" "$TOKEN_B"
[[ "$HTTP_STATUS" == "404" ]] || fail "B polling A's job returned $HTTP_STATUS (expected 404)"

echo "6. B queries with A's documentId: no cross-tenant citations"
http POST /api/v1/rag/query "$TOKEN_B" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"${QUERY}\",\"documentIds\":[\"${DOCUMENT_ID}\"]}"
[[ "$HTTP_STATUS" == "200" ]] || fail "RAG query as B returned $HTTP_STATUS (expected 200)"
CITATIONS_B="$(json_field '.data.citations | length')"
if (( CITATIONS_B > 0 )); then
  ANSWER_B="$(json_field '.data.answer')"
  if [[ "$ANSWER_B" != *"enough information"* ]]; then
    fail "B saw ${CITATIONS_B} citations from A's document (cross-tenant leak): ${ANSWER_B}"
  fi
fi

echo "7. GET /metrics without a token must not expose Prometheus text"
http GET /metrics
if grep -q '# HELP\|# TYPE' "$BODY" 2>/dev/null; then
  fail "/metrics returned Prometheus text without a token (status ${HTTP_STATUS})"
fi

echo "8. WebSocket handshake with the real Origin header"
# The WS server rejects any handshake whose Origin is not in CORS_ORIGINS
# (ws.server.ts) by sending close code 1008 + the ASCII reason
# "origin not allowed". The probe speaks plain HTTP/1.1 upgrade over the
# https URL (some curl builds lack the wss:// protocol); curl never completes
# the WS close handshake, so we assert on the bytes it received within a
# short window instead of the exit code (0 on early EOF, 28 on --max-time —
# both are fine either way).
WS_URL="${BASE_URL}/ws/agent"
WS_KEY="$(head -c 16 /dev/urandom | base64 | tr -d '\n')"
ws_probe() {
  local origin="$1" out="$2"
  curl -sk -i --http1.1 --max-time 2 -o "$out" \
    -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: ${WS_KEY}" \
    -H "Origin: ${origin}" \
    "${WS_URL}" >/dev/null 2>&1 || true
  # LC_ALL=C: the WS close frame puts raw bytes on the same line as the
  # ASCII reason, which UTF-8 locales refuse to match even with grep -a.
  LC_ALL=C grep -aq "101 Switching Protocols" "$out" || {
    echo "--- ws handshake output (Origin: ${origin}) ---" >&2
    cat "$out" >&2
    fail "WS handshake with Origin ${origin} did not switch protocols"
  }
}

WS_GOOD="$TMP_DIR/ws-good.txt"
WS_BAD="$TMP_DIR/ws-bad.txt"
ws_probe "$BASE_URL" "$WS_GOOD"
if LC_ALL=C grep -aq "origin not allowed" "$WS_GOOD"; then
  echo "--- ws handshake output ---" >&2
  cat "$WS_GOOD" >&2
  fail "server rejected the real Origin ${BASE_URL} — add the exact scheme+host+port to CORS_ORIGINS"
fi
ws_probe "https://smoke-invalid-origin.example" "$WS_BAD"
LC_ALL=C grep -aq "origin not allowed" "$WS_BAD" || {
  echo "--- ws handshake output ---" >&2
  cat "$WS_BAD" >&2
  fail "server did not reject an unknown Origin — the WS origin allowlist is not enforced"
}

echo "SMOKE OK"
