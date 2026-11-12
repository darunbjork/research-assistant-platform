# ADR 0003 — Rate limits and the global budget fail closed for paid operations

**Status:** accepted (Phase 2, commits `93b4677`, `28a299f`, `21a14ad`)

## Context

Per-user rate limits and the global daily LLM budget both live in Redis.
Redis can be down (crash, OOM, network). Two failure modes compete:

- **fail open** — keep serving during a Redis outage, but a single hammering
  client can run up an unbounded Gemini bill, and per-user limits stop
  meaning anything;
- **fail closed** — refuse requests, protecting the bill, at the cost of
  availability while Redis is down.

## Decision

Every limiter carries an explicit `failMode` (`RateLimitConfig`), and the
global budget has one policy of its own:

| Limit | Policy when Redis is unreachable |
| --- | --- |
| RAG 60/h, agent 30/h, upload 20/day, eval 20/h, register 5/h | **closed** → 429 with `Retry-After: 60` |
| light 200/h, login 10/15 min | **open** → request proceeds |
| global daily budget (`GLOBAL_DAILY_LLM_CALLS_MAX`) | **closed** → 503 `Daily capacity reached, try again tomorrow` |

The counters themselves use an atomic `INCR` + `EXPIRE NX` MULTI so a key can
never exist without a TTL.

## Consequences

- Money-spending endpoints cannot be driven unbounded during a Redis outage;
  cheap reads and login keep working.
- A Redis outage *looks like* capacity/limit problems: the 503 body is
  identical to a genuinely exhausted budget. Operators must check
  `docs/runbooks/redis-down.md` before telling users to wait for tomorrow.
- Registration is unavailable during a Redis outage (deliberate: signups are
  cheap to abuse at scale).

## Revisit when

- Redis gets HA or the counters move to a durable shared store (then
  fail-closed false positives shrink and cheap endpoints could open up), or
- repeated Redis blips make closed-mode outages the dominant user complaint.
