# ADR 0006 — Speak Completed Answers (Deterministic Text, Opt-In, Turn-Tagged Frames)

**Status:** accepted (VOICE_TTS_PLAN Phases 1–5)

## Context

In Agent (WS) mode a user can type or speak a question, and the answer arrives as text with `[Evidence N]` citations and markdown. Users asked to also *hear* the answer. ElevenLabs bills per character, the free Gemini tier is already the scarcest resource, and an answer can be interrupted at any moment (the user talks again, asks a new question, or closes the tab). A spoken answer must never put the text answer at risk.

## Decision

1. **Speak a deterministic transformation of the final answer, not an LLM summary.** `toSpeakableText()` strips citation tags and markdown, reads list items as sentences, and caps the length at the last full sentence within `TTS_MAX_CHARS` (default 600). No extra Gemini call: no added latency, quota or failure mode, and the spoken words always match the text on screen.
2. **Speaking is opt-in per connection.** The browser sends `set_speak { enabled }`; the server default is off. The UI toggle (🔊, saved in `localStorage`, default on) re-sends it on every authentication, because the setting lives on the socket. Speaking only exists in Agent (WS) mode.
3. **Binary frames carry an 8-byte little-endian header: `uint32 turn` + `uint32 seq`, then PCM16 LE mono at 24 kHz.** `tts_start { turn, sampleRate, chars }` announces a turn; `tts_done { turn }` closes it. `turn` lets the browser drop frames still in flight from an interrupted answer — after a barge-in the old audio cannot leak into the next one. Little-endian matches the PCM byte order and `DataView.getUint32(offset, true)`. This replaced the unused 4-byte big-endian sequence prefix (nothing had ever sent it).
4. **TTS failures never affect the text answer.** Speaking starts only after the `complete` message has been sent and the run is released; any failure (provider outage, spent quota, bad key, daily limit, Redis error) produces a `voice_error` with a `TTS_*` code, shown as a small note — never the chat error banner, never a retracted or changed answer. An aborted turn (barge-in, new question, `voice_start`, `set_speak false`, socket close, shutdown) sends nothing at all.
5. **Spend is bounded where it is incurred:** a per-user daily character counter in Redis (fails closed), the per-answer cap, a TTS-only ElevenLabs key with its own credit cap, and a circuit breaker that opens immediately on a quota response. Provider choice (`TTS_PROVIDER=mock|elevenlabs`) is independent of `VOICE_MOCK` (speech-to-text).

## Consequences

- Speaking adds no Gemini calls and works with mock TTS (silence) entirely offline; tests never reach ElevenLabs.
- A long answer is spoken only up to ~600 characters; the full text is always on screen.
- Spoken characters are not charged to the global LLM/voice budget units in `cost.md` §2; the daily character cap and provider key cap are the TTS controls instead.
- The browser needs a user gesture before audio can play; the player creates/resumes its `AudioContext` on the 🔊 toggle, Send and Mic clicks.
- Interruptions are cheap and safe: the server cancels the upstream stream, the browser stops its scheduled audio and ignores stale-turn frames.

## Revisit when

- Adding an LLM-written spoken summary, speaking progress lines during the run, or streaming sentences before the answer is complete (the turn/seq framing already supports incremental audio).
- Adding a local TTS engine (e.g. Kokoro) — a new `TtsService` implementation behind `TTS_PROVIDER`.
- Speaking in HTTP/RAG modes, which have no socket to stream frames on.
