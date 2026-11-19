#!/usr/bin/env bash
# scripts/k8s-render.sh <out-dir>
#
# Renders deploy/k8s (app.yaml) and deploy/k8s/migrate (migrate.yaml) with
# ResearchBot's three images pinned to the given digests, then checks the
# result. Used by the deploy workflow and by CI (with dummy digests).
#
# Required env (digests only, never tags):
#   BACKEND_DIGEST  MIGRATOR_DIGEST  WEB_DIGEST   e.g. sha256:<64 hex>
#
# Fails if a digest is malformed, a placeholder (all-zero) digest or a tag
# survives, a Secret or Namespace appears, or an app object lacks its
# researchbot.io/tier label (the deploy applies tiers by label, so an
# unlabelled object would silently never be applied).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: k8s-render.sh <out-dir>}"
REGISTRY=ghcr.io/darunbjork

for name in BACKEND_DIGEST MIGRATOR_DIGEST WEB_DIGEST; do
  value="${!name:-}"
  if [[ ! "$value" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::$name must be sha256:<64 hex>, got '${value}'" >&2
    exit 1
  fi
  if [[ "$value" == "sha256:$(printf '0%.0s' {1..64})" ]]; then
    echo "::error::$name is the all-zero placeholder" >&2
    exit 1
  fi
done

# kustomize resolves resources relative to the kustomization, so the wrapper
# overlays live inside the repo (gitignored) and point back at deploy/k8s.
WORK="$(mktemp -d "$ROOT/.k8s-render.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/app" "$WORK/migrate" "$OUT"

images_block() {
  cat <<EOF
images:
  - name: $REGISTRY/researchbot-backend
    digest: $BACKEND_DIGEST
  - name: $REGISTRY/researchbot-migrator
    digest: $MIGRATOR_DIGEST
  - name: $REGISTRY/researchbot-web
    digest: $WEB_DIGEST
EOF
}
{ printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../../deploy/k8s\n'; images_block; } > "$WORK/app/kustomization.yaml"
{ printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../../deploy/k8s/migrate\n'; images_block; } > "$WORK/migrate/kustomization.yaml"

kubectl kustomize "$WORK/app" > "$OUT/app.yaml"
kubectl kustomize "$WORK/migrate" > "$OUT/migrate.yaml"

fail=0
check_image() { # <file> <image> <digest>
  local want="image: $REGISTRY/$2@$3"
  if ! grep -q "$want" "$1"; then
    echo "::error::$(basename "$1"): $2 is not pinned to its digest" >&2
    fail=1
  fi
  if grep -E "image: $REGISTRY/$2" "$1" | grep -vq "@$3\$"; then
    echo "::error::$(basename "$1"): $2 appears with another tag or digest" >&2
    fail=1
  fi
}
check_image "$OUT/app.yaml" researchbot-backend "$BACKEND_DIGEST"
check_image "$OUT/app.yaml" researchbot-web "$WEB_DIGEST"
check_image "$OUT/migrate.yaml" researchbot-migrator "$MIGRATOR_DIGEST"

if grep -nE 'image: [^ ]*(:main|@sha256:0{64})$' "$OUT/app.yaml" "$OUT/migrate.yaml"; then
  echo "::error::a :main tag or placeholder digest survived the render" >&2
  fail=1
fi
if grep -nE '^kind: (Secret|Namespace)$' "$OUT/app.yaml" "$OUT/migrate.yaml"; then
  echo "::error::Secrets and the Namespace are created by hand, never deployed" >&2
  fail=1
fi
# Every top-level object carries exactly one tier label in metadata.labels
# (the tier kustomizations don't label pod templates).
objects=$(grep -c '^kind: ' "$OUT/app.yaml")
tiered=$(grep -cE '^    researchbot.io/tier: (data|app)$' "$OUT/app.yaml")
if [[ "$objects" != "$tiered" ]]; then
  echo "::error::app.yaml has $objects objects but only $tiered carry researchbot.io/tier" >&2
  fail=1
fi
[[ "$fail" == 0 ]] || exit 1

echo "Rendered $objects objects ($(grep -c '^    researchbot.io/tier: data$' "$OUT/app.yaml") data, $(grep -c '^    researchbot.io/tier: app$' "$OUT/app.yaml") app) + migrate Job into $OUT"
