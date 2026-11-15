# ADR 0005 — Single Agent Engine with Transport Adapters

**Status:** accepted (Phase 2–6 refactor, PRs #13–#17)

## Context

`AgentService` (HTTP) and `StreamingAgentService` (WebSocket) each implemented a full ReAct loop with near-duplicate logic (reasoning, tool execution, drafting, evaluation, synthesis, retries, aborts). Behavior and observability drifted (events vs spans/gauge, prompt wording, citation IDs, abort/429 handling in tools), and fixes had to be applied twice.

## Decision

- Introduce a single `AgentEngine` (`backend/src/agents/engine/agent-engine.ts`) as the canonical loop implementation. HTTP and WebSocket services become thin adapters preserving their public APIs and constructors.
- Use an optional event sink (`onEvent` callback) for progress events; HTTP runs with no sink. Transport is explicit (`"http" | "ws"`) for logging/attributes.
- Adopt unified prompt wording/citation format (WS wording, `agent-*` chunk IDs, `agent-retrieved` documentId) and a single tracing/metrics/logging model (`agent.engine`, `agent.transport`, `activeAgentSessions` for all runs).
- Treat caller aborts and Gemini/provider rate limits (`RateLimitError`) as run-level: tools receive `ToolContext { signal? }` and the engine rethrows abort/429 from the tool path so runs stop cleanly and honour `Retry-After`. A per-call timeout (`TimeoutError`) while the caller signal is still live is tool-level: recorded as a failed step so the loop can continue.
- Keep adapters/controllers/WS handlers/frontend protocol shapes unchanged; characterization tests froze transport parity before consolidation.

## Consequences

- One place to fix loop behavior, prompts, spans, and error policy; lower drift risk.
- HTTP now emits the same span/gauge/log structure as WS (under `agent.engine` with transport attribute), which changes observability labels but not public response/event contracts.
- Intentional behavior changes (Phase 5) stop runs on tool-internal aborts/429s and propagate cancellation into retrieval; generic tool errors and live-signal timeouts remain recoverable steps.
- Some prompt/Gemini behaviors (e.g. draft helper swallowing non-abort/non-429 errors to `""`) are preserved as characterized and documented, not "fixed" implicitly.

## Revisit when

- Adding new transports/tools that need richer sink semantics, streaming token output, or per-tool timeout policy distinct from run cancellation.
