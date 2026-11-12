# BASELINE — recorded in Phase 0 of `docs/DEPLOY_READY_PLAN.md`

Branch: `deploy-ready` (cut from `main` @ `6d39b08`)
Date: 2026-11-09

> Note: `git status` on `main` already had uncommitted modifications when the branch was cut
> (`README.md`, `backend/README.md`, `docs/architecture.md`, `docs/gemini-testing-guide.md`,
> `docs/interview-prep.md`, `docs/portfolio-presentation.md`, `docs/system-diagram.md`, plus
> untracked `docs/how-the-app-works.md` and this plan file). They were carried over untouched.

## Test and coverage baseline (`cd backend && npm ci && npm run test:coverage`)

- **Test suites:** 25 passed / 25 total
- **Tests:** 454 passed / 454 total
- **Coverage (all files):**
  - Statements: **61.43 %**
  - Branches: **52.53 %**
  - Functions: **59.43 %**
  - Lines: **61.67 %**
- Jest exits with "Force exiting Jest: Have you considered using `--detectOpenHandles`" (pre-existing warning, tests still pass).

Coverage gate for later phases: never go below **61.43 / 52.53 / 59.43 / 61.67** (statements / branches / functions / lines).

## Tool versions

```
$ node -v
v22.23.3

$ npx prisma -v
prisma                  : 6.19.3
@prisma/client          : 6.19.3
TypeScript              : 6.0.3
Query Engine (Node-API) : libquery-engine c2990dca591cba766e3b7ef5d9e8a84796e47ab7
```

(Local machine already runs Node 22; CI and `frontend/Dockerfile` still pin Node 20 — see D23.)

## Does `npm run lint` actually lint files? (D21 / task 3.9)

**It does lint files, but the `--ext` flag is a no-op.**

- `package.json` runs `eslint src --ext .ts`. ESLint is **v10.4.0**; the `--ext` flag was removed in ESLint 10.
- Observed behaviour: ESLint **does not error** on the removed flag — it silently ignores it and falls back to its own file patterns.
- Verified with `npx eslint src --ext .ts --format json`: **108 files linted, 0 messages, exit 0** — so it is genuinely processing `.ts` files (including `__tests__`), not reporting 0 files.
- Side finding: ESLint prints a `MODULE_TYPELESS_PACKAGE_JSON` warning about `eslint.config.js` being reparsed as ESM.
- `no-explicit-any` is still `'warn'` (D21) and both `eslint.config.js` and `.eslintrc.js` exist (D25).

## §0.2 verification at baseline

| Step | Result |
|---|---|
| `npm run type-check` | pass (no output) |
| `npm run lint` | exit 0 (108 files, 0 messages) |
| `npx prettier --check "src/**/*.ts"` | pass — "All matched files use Prettier code style!" |
| `npm test` (via `test:coverage`) | pass — 454 tests / 25 suites |
| `npm run build` | pass — `dist/app.js` produced |
| `cd frontend && npm run build` | **FAIL (exit 2)** — see FOUND_DURING_FIX.md #F1 |

---

## 0.B Defect confirmation

| ID | Status | Evidence / current location |
|---|---|---|
| D1 | **CONFIRMED** | `backend/src/services/vector.search.service.ts`: 8 `$queryRaw` sites, 6 read `"DocumentChunk"` (L100, L121, L142, L181, L222, L252) and 1 joins `"Document"` (L122). `keyword.search.service.ts`: 3 `"DocumentChunk"` (L100, L124, L149) + 1 `"Document"` (L125). Ingestion writes `"document_chunks"` at `repositories/chunk.repository.ts:63`. (Plan said "~8 queries" in vector search — matches; count of PascalCase refs is 7 in vector + 4 in keyword.) |
| D2 | **CONFIRMED** | `docker-compose.yml:19` mounts `./backend/prisma/init.sql:/docker-entrypoint-initdb.d/init.sql:ro`. `backend/prisma/migrations/` holds 3 conflicting migrations: `20260428012249_init`, `20260503205640_upgrade_to_3072`, `20260515154905_init` (two named `init`). `backend/src/database/migrations/add_vector_index.sql` and `backend/prisma.config.ts.bak` also still exist. |
| D3 | **CONFIRMED** | `vector.search.service.ts:84-105` — the `documentIds.length > 0` branch filters only `dc."documentId" = ANY(...)`, no `d."userId"`. Same structure in `keyword.search.service.ts:83`+. There is also an unconditional "search all users" branch (`else`, L128-146). |
| D4 | **CONFIRMED** | `services/embedding.service.ts:21` → `const EMBEDDING_DIMENSIONS = 3072`. `prisma/schema.prisma:47` → `embedding Unsupported("vector")?` (untyped, no `vector(768)`). |
| D5 | **CONFIRMED** | `vector.search.service.ts:86-105` — one `$queryRaw` template contains `SET LOCAL ivfflat.probes = …;` followed by the `SELECT` (multiple statements in one prepared statement). `defaultProbes` field also present. |
| D6 | **CONFIRMED** | `AGENT_LIMIT` defined at `middleware/rate-limit.middleware.ts:32`, referenced only by `routes/rate-limit.routes.ts` (introspection endpoint). `routes/agent.routes.ts:52` → `router.post("/chat", controller.chat)` with no limiter. `websocket/agent.ws.handler.ts` `handleStart` (L124) has auth check but no rate limit. |
| D7 | **CONFIRMED** | `queue/ingestion.queue.ts:240` `getJobStatus(queue, jobId)` takes no `userId`; `controllers/document.controller.ts:66-95` returns 200 for any existing job after only an authentication check (404 only when the job doesn't exist). |
| D8 | **CONFIRMED** | `grep -rn "?key=" src/services` → **6** services (plan said 5): `evaluator.service.ts:468`, `streaming.agent.service.ts:552`, `embedding.service.ts:175`, `agent.service.ts:532`, `reranker.service.ts:336`, `generation.service.ts:234`. `telemetry/tracer.ts:34` returns `new SimpleSpanProcessor(new ConsoleSpanExporter())` when no OTLP endpoint is set. |
| D9 | **CONFIRMED** | `app.ts:40` → `origin: ["http://localhost:5174", "http://localhost:3001", "http://localhost:5173"]`. `frontend/src/utils/api.ts:19` → fallback `http://localhost:3002`. `frontend/src/hooks/useAgentWebSocket.ts:56` → fallback `ws://localhost:3002`. |
| D10 | **CONFIRMED** | `app.ts:44` → `app.use(express.json())` (default 100 KB). `controllers/document.controller.ts:34` allows `content.length > 500_000` chars. |
| D11 | **CONFIRMED (count is 9, not 8)** | `grep -rn "new PrismaClient" src --include=*.ts` excluding `scripts/` and `__tests__` finds **9**: `middleware/access-control.middleware.ts:5`, `middleware/auth.middleware.ts:7`, `websocket/agent.ws.handler.ts:15`, `app.ts:30`, `queue/ingestion.queue.ts:45`, `controllers/auth.controller.ts:15`, `controllers/agent.controller.ts:16`, `controllers/rag.controller.ts:17`, `controllers/document.controller.ts:11`. |
| D12 | **CONFIRMED** | `utils/redis.ts:20-26` — `retryStrategy(times)` returns `null` once `times > 5` ("stop retrying"). |
| D13 | **CONFIRMED** | Only `telemetry/tracer.ts:59` (SIGTERM) and `:66` (SIGINT) register handlers, and only to shut down OTel. `app.ts` has no `SIGTERM`/`SIGINT`/shutdown code. |
| D14 | **CONFIRMED** | `generation.service.ts:98` builds `systemPrompt = this.buildSystemPrompt(contextBlock)` and passes it as `systemInstruction` (L217); retrieved chunks are inside the system prompt. |
| D15 | **CONFIRMED** | `grep -rn 'signal\|AbortSignal' src/services/*.ts` → **0 matches**. No cancellation/timeout on any Gemini fetch. |
| D16 | **CONFIRMED** | 26 `process.env` reads outside `config/`, `telemetry/`, `scripts/`, tests — e.g. `websocket/agent.ws.handler.ts:16,18,168` (`GEMINI_API_KEY ?? ""`), `app.ts:29`, `utils/redis.ts:15`, `utils/jwt.utils.ts:13-14`. No startup validation. |
| D17 | **CONFIRMED** | `frontend/src/components/DocumentUpload.tsx:43` `reader.readAsText(file)`, `:209` `accept=".txt,.md,.csv"`. `multer` in `package.json` (`^2.1.1`) but **zero** references in `src/`. |
| D18 | **CONFIRMED** | No `backend/Dockerfile`. `docker-compose.yml` services: only `postgres` and `redis` (no app services). `docs/deployment.md` references `docker compose exec backend …` (service doesn't exist) and its multi-line `docker compose -f docker-compose.yml \n -f docker-compose.monitoring.yml up -d --build` lacks the trailing `\`. |
| D19 | **CONFIRMED** | `routes/metrics.routes.ts` — both `/metrics` and `/metrics/json` have no auth check. |
| D20 | **CONFIRMED** | `routes/auth.routes.ts:52` (`/register`) and `:104` (`/login`) — no `createRateLimiter` anywhere in the file. |
| D21 | **CONFIRMED** | `backend/eslint.config.js:20` → `'@typescript-eslint/no-explicit-any': 'warn'`. CI (`ci.yml:75`) greps for `any` but excludes `.test.ts`, `mock`, `__tests__`. |
| D22 | **CONFIRMED** | `backend/.env.example:20-29` — `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, `OTEL_SERVICE_NAME=…`, `OTEL_TRACES_SAMPLER=always_on` etc. are live (uncommented) values; the surrounding prose says "Uncomment to…". |
| D23 | **CONFIRMED** | `.github/workflows/ci.yml:60` → `node-version: "20"`. `frontend/Dockerfile:2,10` → `FROM node:20-alpine`. No `engines` field in either `package.json`, no `.nvmrc`. |
| D24 | **CONFIRMED** | `.github/workflows/ci.yml` has a single job `ci` with backend steps only — no `frontend/` install/lint/build step anywhere. |
| D25 | **CONFIRMED** | Both `backend/.eslintrc.js` (6 bytes) and `backend/eslint.config.js` exist. |

### Mismatches found while confirming (plan vs. code)

- **D11:** 9 `new PrismaClient()` instances, not 8 (all in the places the plan lists plus `document.controller.ts`).
- **D8:** 6 services pass `?key=`, not 5 (added: `generation.service.ts`).
- **D1:** raw-query counts match (8 in vector search, 3 in keyword search); the PascalCase table-name references are 7 and 4 respectively (joins included).
- **New defect (not in the D1–D25 table): the frontend production build fails at baseline** → logged as **F1** in `docs/FOUND_DURING_FIX.md`.
