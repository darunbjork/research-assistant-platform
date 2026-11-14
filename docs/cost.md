# Voice Layer — Cost Model & Provider Caps

**Status:** living document, created Day 1 of the voice curriculum.
**Companion gate:** no real Deepgram or ElevenLabs call may ever be made
until the human spend-cap checklist in §4 is completed and recorded here.
Every env file defaults to `VOICE_MOCK=true` — provider calls are
deterministic in-process stubs, so **default cost is $0.00**.

All prices below were verified against vendor pricing pages on **2026-11-11**.
Re-verify before enabling real mode; vendors change prices without notice.

## 1. Unit rates (pay-as-you-go, list price)

| Provider | Product | Model | Rate | Source (2026-11-11) |
| --- | --- | --- | --- | --- |
| Deepgram | STT, **live streaming** | `nova-3` monolingual | **$0.0077 / audio-min** ($0.46/h) | deepgram.com/pricing |
| Deepgram | STT, live streaming | `nova-2` (legacy, unchanged rates) | $0.00583 / audio-min ($0.35/h) | deepgram.com/pricing FAQ |
| Deepgram | STT, pre-recorded | `nova-3` monolingual | $0.0043 / audio-min | deepgram.com/pricing |
| ElevenLabs | TTS | `eleven_flash_v2_5` (default) | **$0.04 / 1,000 chars** ($40/M) | elevenlabs.io/pricing/api FAQ |
| ElevenLabs | TTS | multilingual / v4 models | $0.08 / 1,000 chars | elevenlabs.io/pricing/api FAQ |
| Google | Gemini spoken summary + existing agent | flash tier (repo name `gemini-3.6-flash`) | ≈ $0.30/1M input, ≈ $2.50/1M output — **verify in AI Studio** | Google AI Studio billing |

Notes:

- Voice mode streams mic audio live → the **streaming** Deepgram rate applies, not pre-recorded. Deepgram bills per second of processed audio, no block rounding; first $200 of PAYG credit is free.
- ElevenLabs counts ~1,000 characters ≈ 1 minute of speech → Flash v2.5 ≈ **$0.04 per minute the agent speaks**; user speech and silence cost nothing.
- Defaults pinned in `backend/src/config/env.ts`: `DEEPGRAM_MODEL=nova-3`, `ELEVENLABS_MODEL_ID=eleven_flash_v2_5` (~100 ms median latency, 40k-char request limit).

## 2. Budget units — CONFIRMED by Darun (Day 1 review) + voice sub-cap

Voice charges ride the **existing global budget** (`budget:llm:<UTC>`,
fail-closed, default 2,000 units/day). **Confirmed** additions **per agent turn**:

| Unit | Quantity per turn | Basis |
| --- | --- | --- |
| Agent turn (already exists) | 5 | charged today at `agent.ws.handler.ts` |
| Spoken summary | 1 | one LLM call, 2–3 sentences (Day 6) |
| STT | `ceil(utterance_seconds / 30)` | 8 s → 1 unit, 45 s → 2 |
| TTS | `ceil(summary_chars / 500)` | 250 chars → 1 unit (500 → 1, 501 → 2) |

- Typical turn = 5 + 1 + 1 + 1 = **8 units**.
- Worst legal turn (60 s utterance, 1,000-char summary) = 5 + 1 + 2 + 2 = **10 units**.
- Day-7 progress lines reuse the TTS unit rate, capped at 2 lines/turn (≤ +2 units).

**Voice sub-cap (confirmed): voice may consume at most 40 % of
`GLOBAL_DAILY_LLM_CALLS_MAX` per UTC day** — default 2,000 ⇒ **800 voice
units/day**. Implemented as `consumeVoiceBudget()` on `budget:voice:<date>`
(Day 2): it increments both the voice and the global counter in one
transaction and refuses when *either* cap is exceeded (fail-closed). Because
voice can never take more than 40 %, a voice burst cannot trigger
"Daily capacity reached" for text users — at least 60 % of the daily budget
is always reserved for them.

Voice limiter and budget both fail **closed**: a refused action never reaches a provider.

## 3. Dollars — stated assumptions, gated audio vs always-open mic

**Stated assumptions (every number below derives from these):**

| Assumption | Value |
| --- | --- |
| Characters of spoken summary per turn | **250** |
| Utterance length per turn (audio streamed) | 8 s |
| Turns per 5-minute session | 6 |
| TTS rate | $0.04 / 1,000 chars (Flash v2.5) |
| STT rate | $0.0077 / audio-minute (nova-3 streaming) |

**Per turn (gated audio):**

| Component | Math | Cost |
| --- | --- | --- |
| STT — nova-3 streaming | 8 s × $0.0077 / 60 | $0.00103 |
| TTS — Flash v2.5 | 250 × $0.04 / 1,000 | $0.01000 |
| Spoken summary — Gemini flash | ~200 in + ~100 out tokens | ≈ $0.00034 |
| **Voice marginal total** | | **≈ $0.0114** |

**Per 1,000 turns:**

| Mode | STT | TTS | Summary | Total |
| --- | --- | --- | --- | --- |
| **Gated** (audio only while speaking) | 133 min × $0.0077 = $1.03 | 250,000 × $0.04/1k = $10.00 | $0.34 | **≈ $11.4** |
| **Always-open mic** (mic streams 50 s/turn) | 833 min × $0.0077 = $6.42 | $10.00 | $0.34 | **≈ $16.8** |

**Per 5-minute session (6 turns):**

| Mode | STT | TTS | Summary | Total |
| --- | --- | --- | --- | --- |
| **Gated** | 48 s ⇒ $0.006 | 1,500 chars ⇒ $0.060 | $0.002 | **≈ $0.068** |
| **Always-open mic** | 5 min ⇒ $0.039 (**6.2×** the gated STT) | $0.060 | $0.002 | **≈ $0.10** |

> Correction: the Day 1 report's "$0.011 TTS per session" and "$3.20 per
> 1,000 turns" were wrong — they mixed a per-turn TTS figure into session and
> 1,000-turn totals. The numbers above supersede them.

**EXPLICIT DAY 4 RULE — Deepgram bills audio *streamed*, not speech
detected.** The client must **stop sending audio during silence and
immediately after `voice_end`** (mic/VAD gate + explicit stop). A mic left
open for a 5-minute session costs ~6× the gated STT estimate. This is a
requirement, not an optimisation.

With `VOICE_MOCK=true` (default): **$0.00** — no network call, no billing.

## 4. Provider spend caps — HUMAN TASK, required before VOICE_MOCK=false

**Hard cap vs alert — what each dashboard *offers* (verified against vendor
docs 2026-11-11):**

| Provider | Hard cap available? | Mechanism | Alerts | This account has (human records) |
| --- | --- | --- | --- | --- |
| Deepgram | **Yes** | Monthly budget in Console → over-limit calls fail **402**. Caveats: usage tracking can lag minutes–hours, audio already being processed may still be billed, budget is org-wide across keys | Email/webhook threshold alerts | [ ] cap `$____` set on `____` (date) |
| ElevenLabs | **Yes** | Per-API-key monthly **`character_limit`** — official API: "requests that incur charges will fail after reaching this monthly limit"; account plan quota as backstop | Plan usage notifications | [ ] cap `____ chars` set on key `____` (date) |
| Gemini | Yes (per plan §H.1) | AI Studio budget/quota controls | Email alerts | [ ] confirmed `____` (date) |

Checkboxes stay unchecked until the human completes them; every daily report
re-flags this.

- [ ] **Deepgram**: hard budget + alert threshold set in console — record cap/date above.
- [ ] **ElevenLabs**: per-key `character_limit` set (service-account key, backend use) — record above.
- [ ] **Gemini**: plan §H.1 budget alerts + key restrictions confirmed (date: `____`).
- [ ] **ElevenLabs effective per-character rate confirmed on OUR plan**: official FAQ states API usage is billed in dollars at the same $/char on every plan (plan allowance vs prepaid top-up), but verify on the dashboard and record the rate + plan: `$____/1k on plan ____` (date: `____`).
- [ ] Keys live only in server env (never browser); key restrictions (IP where supported) applied (date: `____`).
- [ ] §1 rates re-verified on the vendor pricing pages (date: `____`).

## 5. Mitigations (in place / scheduled)

- `VOICE_MOCK=true` default in `backend/.env.example` **and** `.env.production.example` — zero spend by construction (Day 1).
- Startup validation: keys + voice-id required only when `VOICE_MOCK=false`; failures print names only (`env.ts` superRefine, Day 1).
- `docker-compose.prod.yml` forwards the whole `.env.production` via `env_file` — **no compose change needed** for voice vars.
- Voice limiter fail-closed (~20 turns/h, 10 sessions/h) + global budget charge per turn (Days 2/6).
- Voice sub-cap 40 % with **check-before-increment** (atomic Lua): a refused voice call never drains the shared global counter (Day 2.5).
- Per-provider circuit breaker: 5 consecutive failures → open, 5-minute retry (Day 2).
- **Breaker error classification (locked for Day 5):** timeouts, 5xx and network errors count toward the threshold; other 4xx caller errors do **not**; a provider quota signal (Deepgram **402**, ElevenLabs `character_limit` refusal) **opens the breaker immediately** and surfaces `VOICE_BUDGET_REACHED` ("voice budget reached") instead of `PROVIDER_UNAVAILABLE` — retrying for 5 minutes cannot fix a spent cap.
- Hard caps: 60 s utterance, 10 min session, 4 KB frames, 500-char transcripts (Day 1 types).
- Raw audio never persisted; transcripts only, via new Prisma migration (Day 3).
- **Voice transcript retention (Day 3b + Day 4 follow-up):** spoken content is personal data — kept **30 days**, purged on service startup, opportunistically after each save, and by a daily in-process timer (unref'd, cleared on graceful shutdown); user delete cascades all of a user's transcripts. The global sweep is indexed on `createdAt` (migration `20261113000000_voice_transcripts_created_at_index`).
- **Day 5 key hygiene:** the Deepgram key lives only in server env and travels in the `Authorization` header — never in URLs, log lines, or OTel span attributes (D8 lesson).
- **Day 5 design (locked; Deepgram docs checked 2026-11-13):**
  - Key **only** in the `Authorization` header of the Deepgram WS handshake — never in the URL/query, logs, or spans.
  - `{"type":"KeepAlive"}` **text** frames every 3–5 s while the silence gate is closed — Deepgram closes with `NET-0001` after 10 s with no data.
  - `{"type":"Finalize"}` on `voice_end` to flush interim results into a final transcript.
  - Breaker classification (above): 5xx/timeout/network count, other 4xx don't, 402/quota opens immediately as `VOICE_BUDGET_REACHED`.
  - All tests against a **fake Deepgram WS server** (local, no real network).
  - **No real Deepgram call until §4 caps below are confirmed by Darun.** Day 5 ends with mock-only verification.
- Outage runbook `docs/runbooks/voice-provider-outage.md` (Day 12).

## 6. Switching to real mode (only after §4 is checked)

1. Complete §4, write caps + dates into this file.
2. Set `VOICE_MOCK=false` and the three credentials (`DEEPGRAM_API_KEY`,
   `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`) in server env only.
3. Restart — startup validation fails fast if any is missing.
4. Make one manual call; confirm it appears in both dashboards under the caps.
5. Keep dashboard alerts on as defence in depth; our budget + limiter bound usage regardless.
