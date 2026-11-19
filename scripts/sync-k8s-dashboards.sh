#!/usr/bin/env bash
# scripts/sync-k8s-dashboards.sh
# Copies monitoring/grafana/dashboards/*.json into deploy/k8s/base/dashboards/
# for the cluster's Grafana, prefixing each title with "ResearchBot · " so they
# stand out next to Transcribe's dashboards (K3S plan, B0 §4).
#
# WHY a copy: kustomize refuses to read files outside the kustomization root
# (its load restrictor), and the local docker-compose Grafana keeps reading
# monitoring/. CI runs this script and fails if the copies are out of date.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/monitoring/grafana/dashboards"
DEST="$ROOT/deploy/k8s/base/dashboards"

mkdir -p "$DEST"
rm -f "$DEST"/*.json

python3 - "$SRC" "$DEST" <<'PY'
import json, pathlib, sys

src, dest = map(pathlib.Path, sys.argv[1:3])
PREFIX = "ResearchBot · "
for path in sorted(src.glob("*.json")):
    dashboard = json.loads(path.read_text(encoding="utf-8"))
    title = dashboard.get("title", path.stem)
    # "Research Assistant — RAG Overview" -> "ResearchBot · RAG Overview"
    if title.startswith("Research Assistant — "):
        title = title[len("Research Assistant — "):]
    if not title.startswith(PREFIX):
        title = PREFIX + title
    dashboard["title"] = title
    # Dashboard ids are per-Grafana; let the cluster's Grafana assign one.
    dashboard["id"] = None
    out = dest / path.name
    out.write_text(json.dumps(dashboard, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{path.name}: {title}")
PY
