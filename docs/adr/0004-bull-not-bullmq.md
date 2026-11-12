# ADR 0004 — Stay on Bull (not BullMQ)

**Status:** accepted (as-is; Phase 5 task 5.5 notes)

## Context

`package.json` installs **bull@4.16.5** and the code is typed against
`Bull.Queue` (`src/queue/index.ts`, `src/queue/ingestion.queue.ts`).
BullMQ is a different package with a different API, not a drop-in upgrade,
and the deployment plan explicitly lists "migrating Bull to BullMQ" as out of
scope. Bull 4 also has sharp edges: `queue.process()` returns a startup
promise that rejects with `undefined` if the queue is created and closed in
quick succession — this crashed a SIGTERM shutdown until it was caught
(`FOUND_DURING_FIX.md` F9).

## Decision

- Keep Bull 4.x as the queue library.
- Treat the promise returned by `queue.process()` as fallible: attach a
  `.catch()` and log (`createIngestionQueue`).
- Rely on Bull's documented close semantics in shutdown: `queue.close()`
  drains active jobs before the process exits (task 5.5 order).

## Consequences

- No migration work now; ingestion job payloads and retry/backoff behaviour
  (3 attempts, exponential 5s base) stay unchanged.
- We stay on an older, callback-style library; similar landmines (floating
  promises, undocumented rejection reasons) must be handled at call sites.
- Bull creates its own Redis connections from `REDIS_URL`; the shared
  `redis` client is only passed through for embedding-cache use.

## Revisit when

- Bull 4 breaks on a future Node LTS, upstream maintenance stalls, or
  advanced features are needed (job flows, separated workers, rate-limited
  queues) → migrate to BullMQ: job data is plain JSON and carries over, but
  every `Bull.*` call site and the processor registration must be rewritten.
