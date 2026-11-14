// scripts/voice-real-check.ts
//
// Day 5 REAL Deepgram check — PREPARED, NOT RUN.
//
// Waits for Darun's explicit go (after the Deepgram hard cap and a dedicated
// capped key are confirmed). Until then this script must not be executed;
// it double-locks that with DEEPGRAM_REAL_CHECK_OK=1.
//
// What it does, when run:
//   1. Reads DEEPGRAM_API_KEY from the SHELL ENVIRONMENT ONLY — never from
//      .env files (this script does not import dotenv or env.ts).
//   2. Opens one real Deepgram streaming connection with the production
//      client (DeepgramStream + buildListenUrl — raw PCM16 @ 16 kHz, the
//      same bytes the AudioWorklet uploads) in 4096-byte frames:
//        - default: the built-in payload — 10.000 s of a 440 Hz sine tone
//          (16 kHz mono PCM16, 0.4 full scale). No speech, so an empty
//          transcript is printed as-is and NOT an error.
//        - with a path argument: a real 16 kHz mono PCM16 WAV file
//          (RIFF/WAVE, format tag 1 — anything else fails fast). The file's
//          `data` chunk is streamed raw and a NON-EMPTY transcript is
//          asserted in this mode.
//   3. Prints: final transcript, bytes sent, seconds charged (ceil(s/30)
//      unit formula + the seconds behind it), and the expected nova-3 cost.
//   4. Runs a bad-key case: a deliberately invalid key must be rejected at
//      the handshake (4xx → "ignore" classification, breaker untouched).
//
// Key safety: the key is never printed, and every line this script writes
// passes through say() — if the key ever appears in any output the script
// exits non-zero immediately. Uncaught errors are checked the same way.
//
// Usage (from backend/):
//   DEEPGRAM_REAL_CHECK_OK=1 npx ts-node ../scripts/voice-real-check.ts
//   DEEPGRAM_REAL_CHECK_OK=1 npx ts-node ../scripts/voice-real-check.ts /path/to/10s-speech.wav
//
// Expected cost of the good-key case (10 s): nova-3 $0.0077/min ×
// 10/60 ≈ $0.001283 (one STT unit under the 30-second charge formula).

import fs from "fs"
import {
  DeepgramStream,
  DeepgramHandshakeError,
  buildListenUrl,
  classifyHandshakeStatus,
} from "../backend/src/services/deepgram.stream"
import { VOICE_SAMPLE_RATE } from "../backend/src/types/voice.types"

/** Deepgram nova-3 streaming price (docs/cost.md §4). */
const NOVA3_PER_MINUTE_USD = 0.0077
/** PCM16 mono: 2 bytes per sample at VOICE_SAMPLE_RATE. */
const PCM_BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2
const WAV_SECONDS = 10
const FRAME_BYTES = 4096 // production frame size (VOICE_MAX_FRAME_BYTES)
/** Inter-frame gap: Deepgram buffers arrival; billing is per audio second. */
const FRAME_GAP_MS = 5

// ── Key-leak guard ─────────────────────────────────────────────────────────
// Set once in main() from the shell env. Every output line is checked
// against it before being written; a hit aborts the process (exit 1).

let key = ""
const printed: string[] = []

function say(line: string): void {
  if (key.length > 0 && line.includes(key)) {
    process.stderr.write("FATAL: DEEPGRAM_API_KEY appeared in output — aborting.\n")
    process.exit(1)
  }
  printed.push(line)
  process.stdout.write(`${line}\n`)
}

function fail(message: string): never {
  say(`FAIL: ${message}`)
  finalSweep()
  process.exit(1)
}

function finalSweep(): void {
  if (key.length > 0 && printed.some(line => line.includes(key))) {
    process.stderr.write("FATAL: key leak detected in collected output — aborting.\n")
    process.exit(1)
  }
}

function guarded(what: string): (error: unknown) => void {
  return (error: unknown): void => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (key.length > 0 && text.includes(key)) {
      process.stderr.write(`FATAL: key leak via ${what} — aborting.\n`)
      process.exit(1)
    }
    process.stderr.write(`${what}: ${text}\n`)
    process.exit(1)
  }
}

process.on("uncaughtException", guarded("uncaughtException"))
process.on("unhandledRejection", guarded("unhandledRejection"))

// ── Audio payloads ─────────────────────────────────────────────────────────

/**
 * Default payload: the PCM samples of a 10 s 16 kHz mono 16-bit WAV holding
 * a 440 Hz sine (0.4 full scale) — the wire format Deepgram's linear16
 * endpoint expects (no WAV header sent; the listen URL pins
 * encoding=linear16, sample_rate=16000, channels=1). It is a TONE, not
 * speech: an empty transcript is expected in this mode.
 */
function makeWavPcm(seconds: number): Buffer {
  const samples = VOICE_SAMPLE_RATE * seconds
  const buffer = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / VOICE_SAMPLE_RATE) * 0.4 * 32767)
    buffer.writeInt16LE(sample, i * 2)
  }
  return buffer
}

/**
 * Optional payload: parse a real WAV file and return its `data` chunk.
 * The file must be exactly the production audio contract — RIFF/WAVE,
 * format tag 1 (PCM), 16 000 Hz, 1 channel, 16 bits/sample — otherwise the
 * check fails fast before any network use.
 */
function parseWavFile(path: string): Buffer {
  if (!fs.existsSync(path)) {
    fail(`WAV file not found: ${path}`)
  }
  const file = fs.readFileSync(path)
  if (
    file.length < 12 ||
    file.toString("ascii", 0, 4) !== "RIFF" ||
    file.toString("ascii", 8, 12) !== "WAVE"
  ) {
    fail(`not a RIFF/WAVE file: ${path}`)
  }

  let format: number | null = null
  let channels: number | null = null
  let sampleRate: number | null = null
  let bitsPerSample: number | null = null
  let data: Buffer | null = null

  let offset = 12
  while (offset + 8 <= file.length) {
    const chunkId = file.toString("ascii", offset, offset + 4)
    const chunkSize = file.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + chunkSize > file.length) {
      fail(`truncated "${chunkId}" chunk in ${path}`)
    }
    if (chunkId === "fmt ") {
      if (chunkSize < 16) fail(`malformed "fmt " chunk in ${path}`)
      format = file.readUInt16LE(body)
      channels = file.readUInt16LE(body + 2)
      sampleRate = file.readUInt32LE(body + 4)
      bitsPerSample = file.readUInt16LE(body + 14)
    } else if (chunkId === "data") {
      data = file.subarray(body, body + chunkSize)
    }
    offset = body + chunkSize + (chunkSize % 2) // chunks are word-aligned
  }

  if (format === null) fail(`no "fmt " chunk in ${path}`)
  if (format !== 1) fail(`WAV format tag ${format} — need 1 (uncompressed PCM)`)
  if (sampleRate !== VOICE_SAMPLE_RATE) {
    fail(`WAV sample rate ${sampleRate} Hz — need ${VOICE_SAMPLE_RATE} Hz`)
  }
  if (channels !== 1) fail(`WAV channel count ${channels} — need 1 (mono)`)
  if (bitsPerSample !== 16) fail(`WAV bit depth ${bitsPerSample} — need 16 (PCM16)`)
  if (data === null || data.length === 0) fail(`no "data" chunk in ${path}`)
  if (data.length % 2 !== 0) fail(`odd "data" size in ${path} — not whole PCM16 samples`)
  return data
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── The check ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  key = process.env.DEEPGRAM_API_KEY ?? ""
  if (key.length === 0) {
    fail(
      "DEEPGRAM_API_KEY is not set in the shell environment (this script never reads .env files)."
    )
  }
  if (process.env.DEEPGRAM_REAL_CHECK_OK !== "1") {
    fail(
      "Refusing to run: set DEEPGRAM_REAL_CHECK_OK=1 only after Darun confirms " +
        "the Deepgram hard cap and gives the explicit go for the 10 s WAV test."
    )
  }

  const model = process.env.DEEPGRAM_MODEL ?? "nova-3"
  const baseUrl = process.env.DEEPGRAM_WS_URL ?? "wss://api.deepgram.com/v1/listen"
  const url = buildListenUrl(baseUrl, model)

  // Audio source: a WAV path argument → that file (speech expected);
  // no argument → the built-in 440 Hz tone (no speech expected).
  const wavPath = process.argv[2]
  const wavMode = wavPath !== undefined && wavPath.length > 0
  const pcm = wavMode && wavPath !== undefined ? parseWavFile(wavPath) : makeWavPcm(WAV_SECONDS)
  const secondsOfAudio = pcm.length / PCM_BYTES_PER_SECOND

  say("── Real Deepgram check (good key) ──")
  say(`model           : ${model}`)
  say(`endpoint        : ${url}`)
  say("key source      : process.env.DEEPGRAM_API_KEY (shell only; never printed)")
  if (wavMode && wavPath !== undefined) {
    say(
      `audio source    : WAV file ${wavPath} (${pcm.length} B = ${secondsOfAudio.toFixed(3)} s PCM)`
    )
  } else {
    say(
      `audio source    : built-in tone — 440 Hz sine, ${WAV_SECONDS.toFixed(3)} s, ` +
        "16 kHz mono PCM16, 0.4 full scale (NOT speech; empty transcript expected)"
    )
  }

  // ── Good key: connect, stream the payload, finalize ──
  let interimFinal: string | null = null

  const stream = new DeepgramStream({
    url,
    apiKey: key,
    sessionId: "voice-real-check",
    onFinal: text => {
      interimFinal = text
    },
    onFailure: failure => {
      say(`stream failure  : [${failure.action}] ${failure.message}`)
    },
  })

  try {
    await stream.connect()
  } catch (error: unknown) {
    stream.close()
    const status = error instanceof DeepgramHandshakeError ? error.status : null
    fail(`connect with the real key failed (HTTP ${status ?? "network/timeout"}).`)
  }
  say("connect         : ok (key travelled only in the Authorization header)")

  let bytesSent = 0
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    const chunk = pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length))
    if (!stream.sendAudio(chunk)) {
      stream.close()
      fail(`sendAudio rejected after ${bytesSent} bytes.`)
    }
    bytesSent += chunk.length
    await sleep(FRAME_GAP_MS)
  }
  if (bytesSent !== pcm.length) {
    stream.close()
    fail(`internal: sent ${bytesSent} bytes, expected ${pcm.length}.`)
  }

  const flushed = await stream.finalize()
  stream.close()
  const transcript = flushed ?? interimFinal

  if (flushed === null && interimFinal === null) {
    fail(
      "no final transcript after Finalize (timeout) — Deepgram accepted audio but never answered."
    )
  }
  if (wavMode && (transcript ?? "").trim().length === 0) {
    fail("WAV mode requires a non-empty transcript — check that the file contains speech.")
  }

  // ── Report (the four required lines) ──
  const secondsSent = bytesSent / PCM_BYTES_PER_SECOND
  const unitsCharged = Math.ceil(secondsSent / 30)
  const expectedCostUsd = (secondsSent / 60) * NOVA3_PER_MINUTE_USD

  say("")
  say("── Results ──")
  say(`final transcript: ${JSON.stringify(transcript ?? "")}`)
  say(`bytes sent      : ${bytesSent}`)
  say(
    `seconds charged : ${secondsSent.toFixed(3)} → ${unitsCharged} unit(s) ` +
      "(ceil(seconds / 30), remainder carried on the session)"
  )
  say(`expected cost   : $${expectedCostUsd.toFixed(6)} (nova-3 $${NOVA3_PER_MINUTE_USD}/min)`)

  // ── Bad key: handshake must be rejected, classified "ignore" ──
  say("")
  say("── Bad-key case ──")
  const badStream = new DeepgramStream({
    url,
    apiKey: "invalid-key-voice-real-check-000000",
    sessionId: "voice-real-check-bad-key",
    onFinal: () => undefined,
    onFailure: failure => {
      say(`bad-key failure : [${failure.action}] ${failure.message}`)
    },
  })
  try {
    await badStream.connect()
    badStream.close()
    fail("the bad key was ACCEPTED — expected a handshake rejection.")
  } catch (error: unknown) {
    badStream.close()
    const status = error instanceof DeepgramHandshakeError ? error.status : null
    const outcome = classifyHandshakeStatus(status)
    say(
      `bad-key result  : ${status === null ? "network/timeout" : `HTTP ${status}`}` +
        ` → classified "${outcome}" (4xx never counts toward the breaker)`
    )
    if (outcome !== "ignore") {
      fail(`expected a 4xx handshake rejection for the bad key, got status ${String(status)}.`)
    }
  }

  finalSweep()
  say("")
  say("OK — real check complete. Key never printed; nothing persisted.")
}

void run().catch(guarded("run"))
