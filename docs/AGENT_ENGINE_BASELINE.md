# Agent engine consolidation baseline (`refactor/agent-engine`)

- Branch: `refactor/agent-engine` (from `main` @ `ca9bbf5`)
- Date: 2026-11-15
- Working tree at start: unrelated modified/untracked docs present (`backend/README.md`, `docs/architecture.md`, `docs/gemini-testing-guide.md`, `docs/interview-prep.md`, `docs/portfolio-presentation.md`, `docs/system-diagram.md`, `docs/how-the-app-works.md`) — left untouched.

## Baseline verification (before changes)

From `cd backend && npm run test:coverage`:
- Test suites: 51 passed, 51 total
- Tests: 749 passed, 749 total
- Coverage: `agent.service.ts` 96.96% stmts / 79.34% branch / 100% funcs / 96.92% lines (348,388,537,554,611-613); `streaming.agent.service.ts` 95.6% / 73.33% / 100% / 96.64% (174-178,538,641-645)


## Repo-wide coverage totals (floor, from `npx jest --coverage --coverageReporters=text-summary`)

> Note: this coverage run reported 2 failed suites / 4 failed tests in unrelated `text-extraction.service` tests (environment/parser variance), 49 passed suites / 745 passed tests; totals below are from the generated `coverage/coverage-summary.json` and are the **repo-wide floor** (statements/branches/functions/lines), not per-file agent numbers.

- Statements: **60.96%** (1498/2457)
- Branches: **52.01%** (528/1015)
- Functions: **59.23%** (231/390)
- Lines: **61.20%** (1458/2382)

## Divergence map confirmation

| # | Status | Evidence (current line numbers) | Notes |
|---|---|---|---|
| V1 Events | **CONFIRMED** | HTTP `AgentService.run` has no event sink/callback (`backend/src/services/agent.service.ts:50-336`). WS takes `onEvent: AgentEventCallback` and emits `status/step/quality/complete` via `emit()` which catches callback exceptions (`backend/src/services/streaming.agent.service.ts:65,82-88,90-98,189-194,239,245-251,276-282,288,306-310,322-334,363-367,372-376,435-441`). | |
| V2 Tracing | **CONFIRMED** | HTTP imports tracer/spans (`agent.service.ts:24-25,36`) and wraps `agent.run` (50), `agent.reason` (100), `agent.tool.<name>` (155-163) with attributes for query/session/user/iterations/quality/tokens (79-82,102,159-160,279-281). WS has no tracer imports or spans (`streaming.agent.service.ts`: none). | |
| V3 `activeAgentSessions` gauge | **CONFIRMED** | HTTP imports and increments/decrements in `try/finally` (`agent.service.ts:19,71,329-331`). WS does not reference `activeAgentSessions`. | |
| V4 sessionId | **CONFIRMED** | HTTP generates internally: `const sessionId = crypto.randomUUID()` (`agent.service.ts:2,51`). WS receives `sessionId` as parameter (`streaming.agent.service.ts:85`). | |
| V5 Prompt wording | **CONFIRMED** | Reasoning prompt: HTTP longer rules/text (`agent.service.ts:438-467`, e.g. "— try this instead", "Determined sufficient information gathered" context differs) vs WS shorter (`streaming.agent.service.ts:465-488`, e.g. `SUGGESTED QUERY: "..."` without "— try this instead", "RULES:" phrasing). Draft prompt differs (`agent.service.ts:350-363` vs `streaming.agent.service.ts:521-527`). Synthesis prompt differs (`agent.service.ts:493-509` vs `streaming.agent.service.ts:560-573`). `formatToolDescriptions` used similarly but surrounding text differs. | Resolution: adopt WS wording in shared builders (Phase 2). |
| V6 Final status on success | **NOT FOUND as divergence** | HTTP sets `state.status = "done"` and returns `status: state.status` on success (`agent.service.ts:274,299`); aborted paths return `state.status` "aborted" (92-93,293,314). WS sets `state.status = "done"` and returns/hardcodes `"done"` in result objects (`streaming.agent.service.ts:358,369,378`) but emits/returns `"aborted"` on abort (135,323,333,385,395). Effective success result status is `"done"` in both. | Snapshot/Phase 3 must still confirm; unify only if snapshots show difference. |
| V7 Citation `chunkId`/`documentId` prefixes | **CONFIRMED** | HTTP: ``chunkId: `agent-${Date.now()}-${citations.length}``` and `documentId: "agent-retrieved"` (`agent.service.ts:590-593`). WS: ``chunkId: `stream-${Date.now()}-${citations.length}``` and `documentId: "stream-retrieved"` (`streaming.agent.service.ts:618-621`). Frontend grep: `grep -rn "stream-" frontend/src` returned no matches. | Safe to unify to `agent-…` / `"agent-retrieved"`. |
| V8 Parse-failure log message | **CONFIRMED** | `parseToolDecision` logs `"Failed to parse tool decision — defaulting to DONE"` but then throws `"Gemini returned an invalid tool decision. Please try again."` (`agent.service.ts:566-571`). WS throws without the misleading log (`streaming.agent.service.ts:603-605`). | Fix message to reflect throw. |
| V9 Tool error handling swallows abort/429 | **CONFIRMED** | HTTP tool catch records all errors as failed steps: `catch (error) { toolSuccess=false; ... }` with no rethrow for abort/`RateLimitError` (`agent.service.ts:164-172`); draft/synthesis/reasoning paths do rethrow abort/429 elsewhere but tool path swallows. WS same pattern (`streaming.agent.service.ts:201-211`). | Phase 5: rethrow when `signal?.aborted` or `error instanceof RateLimitError`. |
| V10 Tool cancellation not propagated | **CONFIRMED** | HTTP: `tool.execute(decision.input)` (161) — no signal; WS: `tool.execute(decision.input)` (202). `ToolDefinition.execute` takes only `input` (`agent.types.ts:79-84`). `rag.tool.ts` calls `hybridSearchService.search(query.trim(), { topK: 5, userId })` without 3rd signal arg (40-42) though `HybridSearchService.search` accepts `(query, options, signal?)` (`hybrid.search.service.ts:32-36`) and passes it to embedding. | Phase 5: add `ToolContext { signal? }` and thread through. |
| V11 Eval-step `toolUsed` shape | **DISCOVERED (Phase 1)** | HTTP evaluation-step objects include `toolUsed: undefined` (explicit key); WS omits `toolUsed`. Semantic content equal. | No behavior change; engine follows WS shape (omitted). Characterization normalizer drops undefined `toolUsed` (kept). |
| V12 Draft `geminiText` empty/MAX_TOKENS swallowed | **DISCOVERED (Phase 1)** | `draftAnswer` catches errors from `geminiText` and returns `""` for non-abort/non-`RateLimitError`, so the loop continues (no explicit failure). The handoff §13/§20 claim "fails explicitly" is only true for the helper. Behaviour is frozen by characterization S13; **no change in this refactor**. | Phase 6 must correct `docs/CLAUDE_PROJECT_HANDOFF.md` text accordingly. |

## Importers of `AgentService` / `StreamingAgentService`

`grep -rn "AgentService\|StreamingAgentService" backend/src --include="*.ts"` (excluding the service files' own definitions/comments noise): 
- `backend/src/controllers/agent.controller.ts` (HTTP entry)
- `backend/src/websocket/agent.ws.handler.ts` (WS entry)
- `backend/src/__tests__/agent.service.test.ts`
- `backend/src/__tests__/streaming.agent.service.test.ts`
- `backend/src/__tests__/agent.ratelimit.test.ts` (mocks StreamingAgentService)
- `backend/src/__tests__/agent.evidence.regression.test.ts`
- `backend/src/__tests__/ws.hardening.test.ts` (mocks StreamingAgentService)
- `backend/src/__tests__/ws.voice.session.test.ts` (mocks StreamingAgentService)
- `backend/src/__tests__/agent.abort.test.ts`
- `backend/src/__tests__/voice.deepgram.session.test.ts` (mocks StreamingAgentService)
- `backend/src/scripts/test-agent.ts`
- `backend/src/scripts/test-self-correction.ts`

Count: 2 entry points + 8 test files + 2 scripts (matches expectation).

## Notes for next phases
- `frontend/src` has no dependency on `stream-` citation prefix.
- HTTP and WS both currently emit/return success status `"done"`; V6 not observed as a behavioral difference but must be locked by characterization snapshots.
- `search` already supports an abort signal end-to-end except the tool boundary (V10).

## Characterization notes (Phase 1, pending)
- To be filled after characterization run.
