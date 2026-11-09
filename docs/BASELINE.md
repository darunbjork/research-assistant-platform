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
