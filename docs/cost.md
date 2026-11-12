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

## 2. Proposed budget units (Darun confirms before Day 2 implements)

Voice charges ride the **existing global budget** (`budget:llm:<UTC>`,
fail-closed, default 2,000 units/day). Proposed additions **per agent turn**:

| Unit | Quantity per turn | Basis |
| --- | --- | --- |
| Agent turn (already exists) | 5 | charged today at `agent.ws.handler.ts` |
| Spoken summary | 1 | one LLM call, 2–3 sentences (Day 6) |
| STT | `ceil(utterance_seconds / 30)` | 8 s → 1 unit, 45 s → 2 |
| TTS | `ceil(summary_chars / 500)` | 450 chars → 1 unit |

- Typical turn = 5 + 1 + 1 + 1 = **8 units**.
- Worst legal turn (60 s utterance, 1,000-char summary) = 5 + 1 + 2 + 2 = **10 units**.
- Day-7 progress lines reuse the TTS unit rate, capped at 2 lines/turn (≤ +2 units).
- A 5-minute session ≈ 6 turns ≈ **48 units = 2.4 % of the 2,000/day default**.

Voice limiter and budget both fail **closed**: a refused action never reaches a provider.

## 3. Dollars — typical turn, 1,000 turns, 5-minute session

Worked example (typical turn: 8 s utterance, 450-char spoken summary):

| Component | Math | Cost |
| --- | --- | --- |
| STT — nova-3 streaming | 8 s × $0.0077 / 60 | $0.00103 |
| TTS — Flash v2.5 | 450 chars × $0.04 / 1,000 | $0.00180 |
| Spoken summary — Gemini flash | ~200 in + ~100 out tokens | ≈ $0.00034 |
| **Voice marginal total** | | **≈ $0.0032** |
| Existing agent RAG turn | unchanged by voice | ≈ $0.001–0.01 (see AI Studio) |

- **Per 1,000 voice turns ≈ $3.20** voice marginal + existing Gemini agent cost.
- **5-minute voice session ≈ 6 turns ≈ $0.02** voice marginal (+ agent cost).
- With `VOICE_MOCK=true` (default): **$0.00** — no network call, no billing.

## 4. Provider spend caps — HUMAN TASK, required before VOICE_MOCK=false

Checkboxes stay unchecked until the human completes them; every daily report
re-flags this.

- [ ] **Deepgram**: PAYG project created, spend cap or usage alert set in the console — cap recorded: `$____` (date: `____`)
- [ ] **ElevenLabs**: monthly character/USD limit or prepaid-funds cap set for the API key — cap recorded: `$____ / ____ chars` (date: `____`)
- [ ] **Gemini**: existing plan §H.1 budget alerts + key restrictions confirmed (date: `____`)
- [ ] Keys live only in server env (never browser); key restrictions (IP where supported) applied (date: `____`)
- [ ] §1 rates re-verified on the vendor pricing pages (date: `____`)

## 5. Mitigations (in place / scheduled)

- `VOICE_MOCK=true` default in `backend/.env.example` **and** `.env.production.example` — zero spend by construction (Day 1).
- Startup validation: keys + voice-id required only when `VOICE_MOCK=false`; failures print names only (`env.ts` superRefine, Day 1).
- `docker-compose.prod.yml` forwards the whole `.env.production` via `env_file` — **no compose change needed** for voice vars.
- Voice limiter fail-closed (~20 turns/h, 10 sessions/h) + global budget charge per turn (Days 2/6).
- Per-provider circuit breaker: 5 consecutive failures → open, 5-minute retry (Day 2).
- Hard caps: 60 s utterance, 10 min session, 4 KB frames, 500-char transcripts (Day 1 types).
- Raw audio never persisted; transcripts only, via new Prisma migration (Day 3).
- Outage runbook `docs/runbooks/voice-provider-outage.md` (Day 12).

## 6. Switching to real mode (only after §4 is checked)

1. Complete §4, write caps + dates into this file.
2. Set `VOICE_MOCK=false` and the three credentials (`DEEPGRAM_API_KEY`,
   `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`) in server env only.
3. Restart — startup validation fails fast if any is missing.
4. Make one manual call; confirm it appears in both dashboards under the caps.
5. Keep dashboard alerts on as defence in depth; our budget + limiter bound usage regardless.
