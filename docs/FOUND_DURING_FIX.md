# FOUND_DURING_FIX.md

New defects discovered while executing `docs/DEPLOY_READY_PLAN.md`, beyond the D1–D25 table.
One line each: file, line, description. Do not widen scope — fix only what the active task names.

| # | File:line | Description | Found in | Status |
|---|---|---|---|---|
| F1 | `frontend/src/components/AgentStatusBadge.tsx:40` | `npm run build` fails at baseline: `web_searching` key in `STATUS_CONFIG` is not a member of `AgentStatus` (`frontend/src/types/index.ts:60` — union has `searching`, no `web_searching`), so `tsc -b` exits 2 and the bundle never builds. | Phase 0 (§0.2 baseline) | OPEN — needs a task (either add `"web_searching"` to `AgentStatus` or drop the entry) |
