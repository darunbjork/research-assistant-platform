# FOUND_DURING_FIX.md

New defects discovered while executing `docs/DEPLOY_READY_PLAN.md`, beyond the D1–D25 table.
One line each: file, line, description. Do not widen scope — fix only what the active task names.

| # | File:line | Description | Found in | Status |
|---|---|---|---|---|
| F1 | `frontend/src/components/AgentStatusBadge.tsx:40` | `npm run build` fails at baseline: `web_searching` key in `STATUS_CONFIG` is not a member of `AgentStatus` (`frontend/src/types/index.ts:60` — union has `searching`, no `web_searching`), so `tsc -b` exits 2 and the bundle never builds. | Phase 0 (§0.2 baseline) | **FIXED** — `e1b760f` |
| F2 | `frontend/src/types/index.ts` | frontend/src/types duplicates backend types by hand and has drifted (F1 was the first symptom). Out of scope; candidate for a shared types package later. | Phase 0 follow-up | OPEN (out of scope) |
| F3 | `backend/src/utils/global-budget.ts:28` | `GLOBAL_DAILY_LLM_CALLS_MAX` is read straight from `process.env` (with a 2000 fallback) because task 3.1 — the Zod env schema — is not done yet. Move it there when 3.1 lands. | Phase 2 (task 2.4) | OPEN (follow-up in task 3.1) |
| F4 | `backend/src/controllers/agent.controller.ts:63` | Plan 2.9 item 5 says to abort on `req.on("close")` before the response finishes, but on Node >= 16 `req` "close" fires as soon as the request body is read (verified empirically on Node 22.23.3: `res.writableEnded` is still `false`), so the literal pattern would abort every request immediately — or never fire for mid-run disconnects if the listener attaches after body parsing. Implemented with `res.on("close")` + `!res.writableEnded` instead: same intent, correct mechanism. | Phase 2 (task 2.9) | FIXED in task 2.9 |
