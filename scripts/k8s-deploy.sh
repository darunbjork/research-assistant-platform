#!/usr/bin/env bash
# scripts/k8s-deploy.sh — deploy ResearchBot to namespace researchbot.
#
# Called by .github/workflows/deploy.yml once the SSH tunnel and kubeconfig
# are in place (KUBECONFIG points at the namespace-scoped `deployer`).
#
# Required env:  BACKEND_DIGEST  MIGRATOR_DIGEST  WEB_DIGEST  (sha256:…)
# Optional env:  SMOKE_URL (skip the smoke check when empty)
#                NAMESPACE (default researchbot), *_TIMEOUT overrides below
#
# Order (each step must succeed before the next):
#   1. render with the digests (scripts/k8s-render.sh)
#   2. apply the data tier, wait for postgres and redis to be Ready
#   3. migrate Job: delete the old one, apply, wait for Complete.
#      On failure: print its logs and STOP. The app tier is untouched.
#   4. apply the app tier, wait for the backend and web rollouts
#   5. wait for the TLS certificate, then smoke-check SMOKE_URL (200)
#   On any failure in 4–5: roll backend and web back to the revisions that
#   were live before this deploy, then exit non-zero. On the first deploy
#   there is nothing to roll back to; the failed pods stay for inspection.
#
# Rollback undoes pods, NOT the schema: migrations must stay backward
# compatible with the previous release (deploy/k8s/README.md).
#
# Never prints secrets: nothing here reads a Secret, and there is no set -x.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="${NAMESPACE:-researchbot}"
DATA_TIMEOUT="${DATA_TIMEOUT:-300s}"
MIGRATE_TIMEOUT_SECONDS="${MIGRATE_TIMEOUT_SECONDS:-300}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300s}"
CERT_TIMEOUT="${CERT_TIMEOUT:-600s}"
SMOKE_URL="${SMOKE_URL:-}"
SMOKE_ATTEMPTS="${SMOKE_ATTEMPTS:-12}"   # x 10 s = 2 min
RENDER_DIR="${RENDER_DIR:-$(mktemp -d)}"

k() { kubectl --namespace "$NS" --request-timeout=30s "$@"; }
step() { echo "::group::$*"; }
endstep() { echo "::endgroup::"; }

# The deployment.kubernetes.io/revision of a Deployment, empty if it doesn't
# exist yet (first deploy).
revision() {
  k get deployment "$1" --ignore-not-found \
    -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}'
}

diagnose() {
  echo "── pods ──"
  k get pods -o wide || true
  echo "── recent events ──"
  k get events --sort-by=.lastTimestamp 2>/dev/null | tail -n 25 || true
}

# ── 1. Render ──────────────────────────────────────────────────────────────
step "Render manifests"
"$ROOT/scripts/k8s-render.sh" "$RENDER_DIR"
endstep

step "Preflight"
kubectl version --request-timeout=15s
# Fails fast if the tunnel, token or Role is wrong, before anything changes.
k get serviceaccount default -o name
PREV_BACKEND="$(revision backend)"
PREV_WEB="$(revision web)"
echo "live revisions before deploy: backend=${PREV_BACKEND:-none} web=${PREV_WEB:-none}"
endstep

# ── 2. Data tier ───────────────────────────────────────────────────────────
step "Apply data tier (ServiceAccount, NetworkPolicies, config, postgres, redis)"
k apply -f "$RENDER_DIR/app.yaml" -l researchbot.io/tier=data
k rollout status statefulset/postgres --timeout="$DATA_TIMEOUT"
k rollout status statefulset/redis --timeout="$DATA_TIMEOUT"
endstep

# ── 3. Migrate ─────────────────────────────────────────────────────────────
step "Run migrations"
# Jobs are immutable: remove the previous run (its pods go with it).
k delete job migrate --ignore-not-found --wait=true --timeout=120s
k apply -f "$RENDER_DIR/migrate.yaml"

migrate_status=""
deadline=$((SECONDS + MIGRATE_TIMEOUT_SECONDS))
while ((SECONDS < deadline)); do
  conditions="$(k get job migrate -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type}{" "}{end}')"
  case " $conditions " in
    *" Complete "*) migrate_status=complete; break ;;
    *" Failed "*) migrate_status=failed; break ;;
  esac
  sleep 5
done
if [[ "$migrate_status" != complete ]]; then
  echo "::error::Migrations ${migrate_status:-timed out after ${MIGRATE_TIMEOUT_SECONDS}s}. The app tier was NOT touched."
  echo "── migrate logs ──"
  k logs job/migrate --all-containers --tail=200 || true
  diagnose
  endstep
  exit 1
fi
k logs job/migrate --all-containers --tail=50 || true
endstep

# ── 4–5. App tier, with rollback on failure ────────────────────────────────
rollback() {
  echo "::group::Rollback"
  local name prev now
  for name in backend web; do
    if [[ "$name" == backend ]]; then prev="$PREV_BACKEND"; else prev="$PREV_WEB"; fi
    now="$(revision "$name")"
    if [[ -z "$prev" ]]; then
      echo "$name: first deploy, no earlier revision to roll back to; leaving it for inspection"
    elif [[ "$now" == "$prev" ]]; then
      echo "$name: still on revision $prev, nothing to undo"
    else
      echo "$name: rolling back from revision $now to $prev"
      k rollout undo "deployment/$name" --to-revision="$prev" \
        && k rollout status "deployment/$name" --timeout="$ROLLOUT_TIMEOUT" \
        || echo "::error::rollback of $name did not finish; check the cluster"
    fi
  done
  echo "Note: the database schema is NOT rolled back (migrations are forward-only)."
  echo "::endgroup::"
}

# NOTE: `set -e` does not apply inside a function called from `if`, so every
# command that can fail ends in `|| return 1`.
deploy_app() {
  step "Apply app tier"
  k apply -f "$RENDER_DIR/app.yaml" -l researchbot.io/tier=app || return 1
  endstep

  step "Wait for rollouts"
  k rollout status deployment/backend --timeout="$ROLLOUT_TIMEOUT" || return 1
  k rollout status deployment/web --timeout="$ROLLOUT_TIMEOUT" || return 1
  endstep

  if [[ -z "$SMOKE_URL" ]]; then
    echo "SMOKE_URL not set: skipping the certificate wait and smoke check"
    return 0
  fi

  step "Wait for the TLS certificate"
  # Instant once issued; the first deploy waits for Let's Encrypt (DNS-01).
  k wait certificate/researchbot-tls --for=condition=Ready --timeout="$CERT_TIMEOUT" || return 1
  endstep

  step "Smoke check $SMOKE_URL"
  local attempt code
  for ((attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt++)); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$SMOKE_URL" || true)"
    if [[ "$code" == 200 ]]; then
      echo "attempt $attempt: HTTP 200"
      endstep
      return 0
    fi
    echo "attempt $attempt/$SMOKE_ATTEMPTS: HTTP ${code:-no response}"
    sleep 10
  done
  echo "::error::$SMOKE_URL did not return 200"
  endstep
  return 1
}

if ! deploy_app; then
  echo "::endgroup::"
  diagnose
  rollback
  exit 1
fi

echo "Deployed: backend=$BACKEND_DIGEST web=$WEB_DIGEST (backend revision $(revision backend), web revision $(revision web))"
