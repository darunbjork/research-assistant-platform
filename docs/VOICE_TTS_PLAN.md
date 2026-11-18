# VOICE_TTS_PLAN.md: talk or type, then see AND hear the answer

> **For: opencode.** Put this at `docs/VOICE_TTS_PLAN.md`. Base: `main` @ `ff796ef`.
> **Goal:** in Agent (WS) mode, every answer, whether the question was typed or spoken, is shown as text (as today) **and** spoken aloud when the user's 🔊 toggle is on.
> **Out of scope:** an LLM-written spoken summary, speaking progress lines while the agent works, streaming sentences before the answer is complete, Kokoro or other local TTS, speaking in HTTP/RAG modes. The design keeps these possible later.

## 0. Ground rules

The ground rules in `docs/DEPLOY_READY_PLAN.md` §0.1 apply: the repo wins, stop at each phase gate, one commit per task, no `any`, explicit return types, never call real providers in tests, coverage must not go down.

Extra rules:
- **Never push to `main` and never force-push.** Before every commit, `git branch --show-current` must print the feature branch.
- Branch: `git switch main && git pull && git switch -c voice/tts-speak-answers`.
- Open a PR at the end of each phase. **Do NOT merge it.** Stop and send the PR URL.
- Real ElevenLabs is only ever called manually (Phase 6), never in tests or CI.

Verification after every task:
```bash
cd backend && npm run type-check && npm run lint && npx prettier --check "src/**/*.ts" && npm test && npm run build
cd ../frontend && npm run lint && npm test && npm run build
```

---

## Phase 0: Confirm (no code changes)

Report CONFIRMED / NOT FOUND, with file and line, for each:
1. `tts.service.ts`: `createTtsService(false)` throws; `MockTtsService` returns PCM16 silence at `VOICE_SAMPLE_RATE`; `getTtsService()` has no callers outside its own file.
2. `env.ts`: `VOICE_MOCK=false` requires `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`.
3. `voice.types.ts` / `websocket.types.ts`: the binary `tts_chunk` header (4-byte BE uint32 sequence) and the `tts_done` message are defined but never sent.
4. `handleBargeIn` is a no-op.
5. The frontend has no audio playback code (search for `AudioContext` and `tts_`).
6. The agent's `complete` result contains `finalAnswer` with `[Evidence N]` tags and markdown bullets.

**STOP. Report.**

---

## Phase 1: Config, separating TTS from STT

**Why:** `VOICE_MOCK` currently controls both directions. You want real Deepgram (speech to text) together with a choice of TTS, and ElevenLabs keys shouldn't be required unless ElevenLabs is actually used.

1. `env.ts`:
   - `TTS_PROVIDER: "mock" | "elevenlabs"`, default `"mock"`.
   - `TTS_MAX_CHARS`: default `600`, range 100–2000. This caps the characters spoken per answer, because ElevenLabs bills per character.
   - `TTS_DAILY_CHARS_PER_USER`: default `20000`.
   - `ELEVENLABS_OUTPUT_FORMAT`: default `pcm_24000`.
   - Require `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` **only when `TTS_PROVIDER=elevenlabs`**.
   - `VOICE_MOCK` now controls STT only. Update its comment.
2. Add `TTS_SAMPLE_RATE = 24000` to `voice.types.ts`. Keep it **separate** from the 16 kHz STT rate, so the two sample rates are never mixed.
3. `createTtsService(provider)` returns the mock or (Phase 3) ElevenLabs. Update `.env.example`, `.env.production.example` and the env tests (keys required only for elevenlabs; defaults; ranges).

Commit: `feat(voice): TTS_PROVIDER config, independent of VOICE_MOCK`

---

## Phase 2: Turning the answer into speakable text (pure function)

Create `backend/src/services/speakable-text.ts`:
```ts
export function toSpeakableText(answer: string, maxChars: number): string
```
Rules, applied in this order:
1. Remove citation tags: `[Evidence 1]`, `[Evidence 1, Evidence 2]`, `[Source 3]`, and any other `[...]` up to 40 characters long (this also catches audio-style tags like `[warmly]`).
2. Remove markdown: `**`, `*`, `_`, `#` headings, backticks, and link syntax `[text](url)` (keep the text).
3. Turn bullet and numbered lines into sentences: join them with ". " and add a final period if one is missing.
4. Collapse runs of whitespace, and remove spaces before punctuation.
5. If the result is longer than `maxChars`, cut at the **last sentence end** (`.`, `!` or `?`) before the limit. If there's no sentence end, cut at the last word and add "…".
6. An empty result returns `""`, and the caller then skips TTS.

Tests (table-driven), at minimum:
- each of your three real answers
- `[Evidence 1, Evidence 2]`
- a mixed bullet list
- a link
- an answer that's only citations
- a cut exactly at a sentence boundary
- no sentence end before the limit
- non-ASCII text (Swedish å/ä/ö survives)

Commit: `feat(voice): toSpeakableText (strip citations/markdown, sentence-safe cap)`

---

## Phase 3: The ElevenLabs streaming client (tested with mocked fetch)

Create `ElevenLabsTtsService` in `tts.service.ts` with a **streaming** interface:
```ts
synthesizeStream(req: { text: string; sessionId: string }, signal: AbortSignal): AsyncIterable<Buffer>
```
- `POST https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream?output_format={ELEVENLABS_OUTPUT_FORMAT}`. Header: `xi-api-key`. Body: `{ text, model_id: ELEVENLABS_MODEL_ID }`.
- Read `response.body` and yield chunks. Re-chunk to **even byte lengths** (PCM16 samples are 2 bytes, and a split sample crackles) with at most 8 KB per chunk.
- Timeouts: use `withTimeout(signal, …)`; 10 s to the first byte.
- Error mapping:
  - 401/403 → `TTS_AUTH`
  - 402, or a quota message → `TTS_QUOTA`
  - 429 → `RateLimitError`
  - 5xx or network failure → `TTS_UNAVAILABLE`

  Wrap the whole call in the existing `ttsBreaker`.
- **Never log the text or the key.** Log only `chars`, `sessionId`, `durationMs`, `bytes`.
- `MockTtsService` also implements `synthesizeStream`: silence in 4 KB chunks, so the whole pipeline can run offline.
- Tests (mocked `fetch`): the request URL, headers and body; odd-length upstream chunks are re-chunked to even lengths; each error code maps correctly; aborting stops iteration with no further reads; the breaker opens after repeated failures.

Commit: `feat(voice): ElevenLabs streaming TTS client behind TtsService`

**STOP. Open a PR for Phases 1–3, then report.**

---

## Phase 4: Server wiring (speak after `complete`)

### 4.1 Protocol (additive; nothing sends TTS today, so the header can safely change)
- C→S `{ type: "set_speak", enabled: boolean }`. A per-connection setting, **default false**.
- S→C `{ type: "tts_start", sessionId, turn: number, sampleRate: 24000, chars: number }`.
- S→C binary frames: an **8-byte header**, `uint32 LE turn` + `uint32 LE seq`, followed by the PCM16 LE mono audio. **Replace** the documented 4-byte header.
  - **Why `turn`:** after barge-in or a new question, audio frames from the old answer may still be on the way. The browser drops any frame whose `turn` isn't the current one.
  - **Why LE:** it matches the PCM byte order and `DataView.getUint32(0, true)`.
- S→C `{ type: "tts_done", sessionId, turn }`. S→C `voice_error` codes: `TTS_UNAVAILABLE`, `TTS_QUOTA`, `TTS_DAILY_LIMIT`.

### 4.2 Flow in `agent.ws.handler.ts`
After the engine resolves with a completed (not aborted) result, **and** `speakEnabled` is true:
1. `text = toSpeakableText(result.finalAnswer, env.TTS_MAX_CHARS)`. If it's empty, skip.
2. **Per-user daily character cap:** Redis `INCRBY tts:chars:{userId}:{YYYY-MM-DD}` with a 48-hour TTL. If that pushes the total over `TTS_DAILY_CHARS_PER_USER`, send `TTS_DAILY_LIMIT` and skip (the text answer has already been delivered). If Redis errors, **fail closed** and skip TTS.
3. Increment `turn`, send `tts_start`, then send the frames with `ws.send(buf, { binary: true })`. Respect backpressure: if `ws.bufferedAmount` goes above 1 MB, wait until it drains.
4. Send `tts_done`.
5. Record `voice_tts_chars_total` (counter, no labels) and `voice_tts_first_byte_seconds` (histogram).

**Cancellation:** keep one TTS `AbortController` per connection. Abort it on:
- `barge_in` (`handleBargeIn` stops being a no-op)
- a new `start`
- `voice_start`
- `set_speak false`
- socket close
- shutdown (add it to the existing abort registry)

An aborted TTS sends no `tts_done` and no error.

**Failure isolation:** a TTS failure must **never** change or retract the text answer. It only sends a `voice_error`.

Tests (mock TTS, real handler):
- speak on: `complete` → `tts_start` → binary frames with increasing `seq` and the same `turn` → `tts_done`
- speak off: no TTS messages at all
- barge-in partway: frames stop, no `tts_done`
- a new question increments `turn`
- going over the daily cap → `TTS_DAILY_LIMIT`, with the text answer still delivered
- a provider error → `voice_error` with the text answer unchanged
- a Redis error → TTS skipped (fail closed)
- an aborted agent run → no TTS

Commits: `feat(voice): set_speak + tts_start/turn-tagged frames` and `feat(voice): speak completed answers with per-user char cap and barge-in abort`

---

## Phase 5: Frontend (player and controls)

1. `frontend/src/hooks/useTtsPlayer.ts`:
   - Create the `AudioContext` lazily, **after a user gesture** (clicking 🔊 or the mic), because browsers block audio that starts before any user interaction.
   - On `tts_start`: set `currentTurn` and reset `nextStartTime = ctx.currentTime + 0.05`.
   - On a binary frame: read the header with `DataView` (LE). **Drop the frame if `turn !== currentTurn`.** Convert Int16 to Float32 (divide by 32768) into an `AudioBuffer` at `sampleRate`, then schedule it with `source.start(nextStartTime)` and advance `nextStartTime` by the buffer's duration. That gives gapless playback.
   - `stop()`: stop every scheduled source and clear the queue.
   - Expose `isSpeaking`.
2. `useAgentWebSocket`: route binary messages to the player (set `ws.binaryType = "arraybuffer"`), handle `tts_start`/`tts_done`, and send `set_speak` on connect and whenever the toggle changes.
3. `AgentChat`:
   - A **🔊 Speak answers** toggle, saved in `localStorage` inside a try/catch, default ON.
   - A **⏹ Stop** button while audio is playing (stops the player and sends `barge_in`).
   - **Pressing the mic while audio is playing:** stop the player and send `barge_in` before `voice_start`.
   - Sending a new typed question stops the player too.
   - Show `TTS_*` errors as a small note under the answer.
4. Tests (Vitest, mocked `AudioContext`):
   - frames are scheduled in order with no gaps
   - stale-turn frames are dropped
   - `stop()` clears the queue
   - the toggle sends `set_speak`
   - pressing the mic while speaking sends `barge_in` and stops playback

Commit: `feat(frontend): TTS player, speak toggle, stop and barge-in`

---

## Phase 6: Manual check, docs, cost

1. **Mock first:** `TTS_PROVIDER=mock`. Ask a typed question with 🔊 on. You should see the text, `tts_start` → binary frames → `tts_done` in DevTools under WS, and hear silence. Then barge in by pressing the mic partway through: the frames stop.
2. **Real (the human runs this):** `TTS_PROVIDER=elevenlabs`. The restricted key (Text to Speech access only, with a credit cap) is already in `backend/.env`. Ask:
   - a typed question
   - a spoken question
   - a question, then pressing the mic halfway through the answer (the audio must stop immediately)
3. Update `docs/cost.md`. ElevenLabs costs **$0.04 per 1,000 characters** on `eleven_flash_v2_5`, so the 600-character cap means at most ~$0.024 per spoken answer. Add the per-user daily cap and the provider credit cap.
4. Write the ADR `docs/adr/0006-speak-answers.md`. It should cover: why a deterministic speakable text instead of an LLM summary (no extra Gemini call, latency or quota); why speaking is opt-in per connection; why the 8-byte LE header with `turn`; why TTS failures never affect the text answer.
5. Update the handoff §14 (voice): TTS is implemented, barge-in stops playback, and `TTS_PROVIDER` exists.

Commit: `docs(voice): cost, ADR 0006, handoff update for spoken answers`

**FINAL STOP. Open the PR and report:**
- the PR URL
- the test counts (backend and frontend)
- the mock-mode check result
- what the human still needs to run for the real ElevenLabs check
