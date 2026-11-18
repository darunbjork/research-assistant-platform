import type WebSocket from "ws"
import { prisma } from "../utils/prisma"
import { verifyAccessToken } from "../utils/jwt.utils"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { GenerationService } from "../services/generation.service"
import { StreamingAgentService } from "../services/streaming.agent.service"
import { parseClientMessage, toJson, type ServerMessage } from "../types/websocket.types"
import {
  VOICE_SAMPLE_RATE,
  VOICE_MAX_FRAME_BYTES,
  VOICE_MAX_UTTERANCE_MS,
  VOICE_MAX_SESSION_MS,
  type VoiceErrorCode,
} from "../types/voice.types"
import { logRagEvent, logError } from "../utils/logger"
import {
  consumeRateLimit,
  AGENT_LIMIT,
  VOICE_TURN_LIMIT,
  VOICE_SESSION_LIMIT,
} from "../middleware/rate-limit.middleware"
import { consumeGlobalBudget, consumeVoiceBudget } from "../utils/global-budget"
import { MAX_QUERY_LENGTH } from "../middleware/validate.middleware"
import redis from "../utils/redis"
import { env } from "../config/env"
import {
  DeepgramStream,
  DeepgramHandshakeError,
  buildListenUrl,
  classifyHandshakeStatus,
  registerUpstream,
  unregisterUpstream,
} from "../services/deepgram.stream"
import { sttBreaker } from "../services/stt.service"
import { saveVoiceTranscript } from "../services/voice.transcript.service"

// ── Hardening constants (task 2.8) ────────────────────────────────────────
// No successful auth within this window ⇒ close the connection.
const AUTH_TIMEOUT_MS = 10_000
// Application close codes (4000-4999 range is reserved for applications).
const CLOSE_AUTH_TIMEOUT = 4001
const CLOSE_TOKEN_EXPIRED = 4001

// ── Voice layer constants (Day 3a) ────────────────────────────────────────
// 16 kHz PCM16 mono is 32 bytes per millisecond (32 000 B/s).
const PCM_BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000
// 60 s of that audio = 60 000 ms × 32 B = 1 920 000 bytes — the server-side
// utterance cap, enforced by counting bytes (no clock dependency).
const MAX_UTTERANCE_BYTES = VOICE_MAX_UTTERANCE_MS * PCM_BYTES_PER_MS
// STT charge formula (agreed with Darun 2026-11-14): 1 unit per 30 s of
// audio — ceil(seconds / 30), where seconds = bytes forwarded upstream ÷
// PCM_BYTES_PER_SECOND. STT_BYTES_PER_UNIT is the byte form (960 000 B);
// charging ceil(forwardedBytes / STT_BYTES_PER_UNIT) keeps sub-30 s
// remainders on the session so short utterances are neither over-charged
// (each < 30 s of audio does not buy its own unit across utterances) nor
// under-charged (fractional seconds are never floored away first).
const PCM_BYTES_PER_SECOND = PCM_BYTES_PER_MS * 1000
const STT_BYTES_PER_UNIT = 30 * PCM_BYTES_PER_SECOND
// Pacing grace: a sender may run 2 s of audio ahead of real time (network
// jitter, bursty capture). Anything beyond that is dropped, not queued —
// Deepgram bills audio *streamed*, so an always-open mic must not be able
// to push 5 minutes of audio in 1 second (cost.md, Day 4 rule).
const PACE_BURST_BYTES = PCM_BYTES_PER_MS * 2000

/** Per-connection voice session state (one utterance at a time). */
interface VoiceSession {
  sessionId: string
  startedAtMs: number
  utteranceOpen: boolean
  bytesReceived: number // this utterance only
  droppedFrames: number // this utterance only
  /**
   * Bytes actually forwarded upstream this session — the charge basis.
   * Session-scoped so sub-unit remainders carry across utterances; frames
   * rejected before forwarding (oversized, paced out, over the caps) and
   * frames stopped by a refused charge never enter it.
   */
  sttForwardedBytes: number
  /** STT units already charged this session: ceil(bytes / STT_BYTES_PER_UNIT). */
  sttChargedUnits: number
}

// ── Service Instances ─────────────────────────────────────────────────────
// Shared across all WebSocket connections — created once at module load.
// This is safe because the services are stateless (no per-connection state).
const embeddingService = new EmbeddingService(env.GEMINI_API_KEY, redis)
const hybridSearchService = new HybridSearchService(prisma, embeddingService)
const generationService = new GenerationService(env.GEMINI_API_KEY)

// ── Running-agent registry (task 5.5) ─────────────────────────────────────
// Every in-flight run's AbortController, across all live connections, so
// graceful shutdown can abort them before closing the sockets.
const activeRunControllers = new Set<AbortController>()

/** Abort every in-flight agent run. Called once during shutdown (step 3). */
export function abortRunningAgents(): void {
  for (const controller of activeRunControllers) {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }
  activeRunControllers.clear()
}

// ── Handler Class ─────────────────────────────────────────────────────────

export class AgentWsHandler {
  private userId: string | null = null // null until authenticated
  private isRunning: boolean = false // true while agent is executing
  /** Aborts the in-flight agent run when the connection closes. */
  private runController: AbortController | null = null
  /** `exp` (seconds since epoch) of the token accepted at auth time. */
  private tokenExp: number | null = null
  private authTimer: ReturnType<typeof setTimeout> | null = null
  /** Active voice session (Day 3a); null until the first voice_start. */
  private voiceSession: VoiceSession | null = null
  /** Day 5: Deepgram upstream for the current utterance (real mode only). */
  private deepgram: DeepgramStream | null = null
  /** voice_start timestamp — transcript_final latency is measured from it. */
  private utteranceStartedAtMs = 0
  /**
   * Serialises binary frame handling: pacing/caps stay synchronous in the
   * chain, and the async per-second budget charge can never race a later
   * frame (frames are processed strictly in arrival order).
   */
  private audioChain: Promise<void> = Promise.resolve()
  /** set_speak: speak completed answers aloud on this connection (default off). */
  private speakEnabled = false

  constructor(private readonly ws: WebSocket) {
    // Auth timeout: a connection that never authenticates is closed (4001)
    // so an open socket can't sit around forever consuming resources.
    this.authTimer = setTimeout(() => {
      if (this.userId === null) {
        logRagEvent("agent_step", "WebSocket auth timeout — closing connection", {
          service: "AgentWsHandler",
        })
        this.ws.close(CLOSE_AUTH_TIMEOUT, "authentication timeout")
      }
    }, AUTH_TIMEOUT_MS)

    this.setup()
  }

  // ── Setup ─────────────────────────────────────────────────────────────
  // Registers WebSocket event listeners.
  private setup(): void {
    // Send initial connected message
    this.send({
      type: "connected",
      sessionId: "pending-auth",
      message: "Connected to ResearchBot. Please authenticate.",
    })

    // Handle incoming messages from the client. Binary frames are AUDIO —
    // routed to the voice path BEFORE any JSON parsing (Day 3a) and
    // rejected outright until authentication has completed.
    this.ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        // Day 5: the real-mode path charges the voice budget per whole
        // second forwarded — async — so frames queue in arrival order.
        this.audioChain = this.audioChain
          .then(() => this.handleAudioFrame(bytes))
          .catch((error: unknown) => {
            logError("Voice frame handling failed", error, {
              service: "AgentWsHandler",
              userId: this.userId ?? "unauthenticated",
            })
          })
        return
      }
      void this.handleMessage(raw.toString())
    })

    // Handle connection close
    this.ws.on("close", (_code: number, _reason: Buffer) => {
      this.clearAuthTimer()
      // Client went away — cancel any in-flight agent run (task 2.9).
      this.runController?.abort()
      // Day 5 rule 2: client close → CloseStream then close on the upstream.
      this.closeUpstream()
      logRagEvent("agent_step", "WebSocket connection closed", {
        service: "AgentWsHandler",
        userId: this.userId ?? "unauthenticated",
      })
    })

    // Handle errors
    this.ws.on("error", (error: Error) => {
      logError("WebSocket error", error, {
        service: "AgentWsHandler",
        userId: this.userId ?? "unauthenticated",
      })
    })
  }

  // ── Handle Incoming Message ────────────────────────────────────────────
  private async handleMessage(rawText: string): Promise<void> {
    const message = parseClientMessage(rawText)

    if (message === null) {
      this.send({
        type: "error",
        sessionId: "unknown",
        message: "Invalid message format. Expected JSON with a 'type' field.",
        code: "INVALID_MESSAGE",
      })
      return
    }

    switch (message.type) {
      case "ping":
        this.send({ type: "pong" })
        break

      case "auth":
        await this.handleAuth(message.token)
        break

      case "start":
        await this.handleStart(message.query, message.sessionId, "text")
        break

      case "voice_start":
        await this.handleVoiceStart(message.sessionId)
        break

      case "voice_end":
        await this.handleVoiceEnd(message.sessionId)
        break

      case "barge_in":
        this.handleBargeIn(message.sessionId)
        break

      case "set_speak":
        this.speakEnabled = message.enabled
        break
    }
  }

  // ── Handle Authentication ──────────────────────────────────────────────
  private async handleAuth(token: string): Promise<void> {
    // Strip "Bearer " prefix if present
    const cleanToken = token.startsWith("Bearer ") ? token.slice(7) : token

    try {
      const payload = verifyAccessToken(cleanToken)

      // The token is cryptographically valid — now prove the account still
      // exists. Sockets live for hours and must not outlive deleted users
      // (Day 3a); the DB check runs again at every voice_start.
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true },
      })
      if (user === null) {
        this.send({
          type: "error",
          sessionId: "auth",
          message: "Authentication failed. Please provide a valid access token.",
          code: "AUTH_FAILED",
        })
        logRagEvent("agent_step", "WebSocket auth rejected: user no longer exists", {
          service: "AgentWsHandler",
          userId: payload.userId,
        })
        return
      }

      this.userId = payload.userId
      this.tokenExp = payload.exp ?? null
      this.clearAuthTimer()

      this.send({
        type: "auth_confirmed",
        userId: payload.userId,
      })

      logRagEvent("agent_step", "WebSocket client authenticated", {
        service: "AgentWsHandler",
        userId: payload.userId,
      })
    } catch (error: unknown) {
      this.send({
        type: "error",
        sessionId: "auth",
        message: "Authentication failed. Please provide a valid access token.",
        code: "AUTH_FAILED",
      })

      logError("WebSocket auth failed", error, {
        service: "AgentWsHandler",
      })
    }
  }

  // ── Handle Agent Start ─────────────────────────────────────────────────
  private async handleStart(
    query: string,
    sessionId: string,
    origin: "text" | "voice"
  ): Promise<void> {
    // Must be authenticated first
    if (this.userId === null) {
      this.send({
        type: "error",
        sessionId,
        message: "Authentication required before starting an agent session.",
        code: "NOT_AUTHENTICATED",
      })
      return
    }

    // The access token may expire while the connection stays open (15m in
    // production). Frontend reconnects and re-authenticates (task 3.6).
    if (this.tokenExp !== null && Date.now() / 1000 > this.tokenExp) {
      this.send({
        type: "error",
        sessionId,
        message: "Access token expired. Please reconnect and re-authenticate.",
        code: "TOKEN_EXPIRED",
      })
      this.ws.close(CLOSE_TOKEN_EXPIRED, "token expired")
      return
    }

    // AGENT_LIMIT applies to WebSocket starts exactly as it does to HTTP.
    const decision = await consumeRateLimit(this.userId, AGENT_LIMIT)
    if (!decision.allowed) {
      this.send({
        type: "error",
        sessionId,
        message: AGENT_LIMIT.message,
        code: "RATE_LIMITED",
      })
      return
    }

    // Prevent concurrent sessions on the same connection
    if (this.isRunning) {
      this.send({
        type: "error",
        sessionId,
        message: "An agent session is already running on this connection.",
        code: "SESSION_BUSY",
      })
      return
    }

    if (!query || query.trim() === "") {
      this.send({
        type: "error",
        sessionId,
        message: "Query cannot be empty.",
        code: "INVALID_QUERY",
      })
      return
    }

    if (query.length > MAX_QUERY_LENGTH) {
      this.send({
        type: "error",
        sessionId,
        message: `Query too long. Maximum ${MAX_QUERY_LENGTH} characters.`,
        code: "INVALID_QUERY",
      })
      return
    }

    // Daily budget: an agent run costs 5 units. Fails closed. Voice-origin
    // runs charge the 40% voice sub-cap (both counters, atomic); text-origin
    // runs always charge the global budget even if a voice session is open.
    const viaVoice = origin === "voice"
    const budgetCharged = viaVoice ? await consumeVoiceBudget(5) : await consumeGlobalBudget(5)
    if (!budgetCharged) {
      this.send({
        type: "error",
        sessionId,
        message: "Daily capacity reached, try again tomorrow",
        code: "CAPACITY_REACHED",
      })
      return
    }

    this.isRunning = true
    const runController = new AbortController()
    this.runController = runController
    activeRunControllers.add(runController)

    logRagEvent("agent_step", "Agent session started via WebSocket", {
      service: "AgentWsHandler",
      sessionId,
      userId: this.userId,
      viaVoice,
    })

    try {
      // Create the streaming agent with the send callback
      const streamingAgent = new StreamingAgentService(
        env.GEMINI_API_KEY,
        hybridSearchService,
        generationService
      )

      // The onEvent callback converts each ServerMessage into a WebSocket send
      const onEvent = (message: ServerMessage): void => {
        // Check connection is still open before sending
        if (this.ws.readyState === 1) {
          // 1 = OPEN
          this.send(message)
        }
      }

      await streamingAgent.run(query.trim(), this.userId, sessionId, onEvent, runController.signal)
    } catch (error: unknown) {
      // Aborted by a client disconnect: info-level only, no error message.
      if (runController.signal.aborted) {
        logRagEvent("agent_step", "Agent session run aborted (connection closed)", {
          service: "AgentWsHandler",
          sessionId,
          userId: this.userId,
        })
        return
      }

      logError("Agent session failed", error, {
        service: "AgentWsHandler",
        sessionId,
        userId: this.userId,
      })

      this.send({
        type: "error",
        sessionId,
        message: error instanceof Error ? error.message : "Agent session failed unexpectedly.",
        code: "AGENT_ERROR",
      })
    } finally {
      this.isRunning = false
      this.runController = null
      activeRunControllers.delete(runController)
    }
  }

  // ── Voice layer (Day 3a) ────────────────────────────────────────────────

  /** Typed voice failure → voice_error on the wire. */
  private sendVoiceError(code: VoiceErrorCode, message: string, sessionId?: string): void {
    this.send({
      type: "voice_error",
      sessionId: sessionId ?? this.voiceSession?.sessionId ?? "unknown",
      code,
      message,
    })
  }

  /**
   * voice_start: open an utterance (and, the first time, the session).
   * Re-checks auth state AND that the user still exists — sockets live for
   * hours, so connect-time checks are not enough.
   */
  private async handleVoiceStart(sessionId: string): Promise<void> {
    if (this.userId === null) {
      this.sendVoiceError("NOT_AUTHENTICATED", "Authenticate before starting voice.", sessionId)
      return
    }

    if (this.tokenExp !== null && Date.now() / 1000 > this.tokenExp) {
      this.sendVoiceError(
        "TOKEN_EXPIRED",
        "Access token expired. Please reconnect and re-authenticate.",
        sessionId
      )
      this.ws.close(CLOSE_TOKEN_EXPIRED, "token expired")
      return
    }

    let user: { id: string } | null = null
    try {
      user = await prisma.user.findUnique({
        where: { id: this.userId },
        select: { id: true },
      })
    } catch (error: unknown) {
      logError("Voice start user re-check failed", error, {
        service: "AgentWsHandler",
        userId: this.userId,
      })
      this.sendVoiceError("VOICE_INTERNAL", "Could not start voice session.", sessionId)
      return
    }
    if (user === null) {
      this.voiceSession = null
      this.sendVoiceError("NOT_AUTHENTICATED", "Account no longer exists.", sessionId)
      return
    }

    const existing = this.voiceSession
    const isRestart = existing !== null && existing.sessionId === sessionId

    if (existing !== null) {
      const ageMs = Date.now() - existing.startedAtMs
      if (ageMs > VOICE_MAX_SESSION_MS) {
        this.voiceSession = null
        // Day 5 rule 2: session cap → CloseStream then close.
        this.closeUpstream()
        this.sendVoiceError(
          "SESSION_LIMIT",
          `Voice session exceeded ${VOICE_MAX_SESSION_MS / 60_000} minutes.`,
          sessionId
        )
        return
      }
    }

    // Day 3b: quota gates — every voice_start is one voice turn. A
    // brand-new session also consumes the scarcer session slot (10/h vs
    // 20/h). All charges happen BEFORE any audio is accepted (so before
    // any provider stream can open on Day 5) and all limiters fail CLOSED.
    if (!isRestart) {
      const sessionDecision = await consumeRateLimit(this.userId, VOICE_SESSION_LIMIT)
      if (!sessionDecision.allowed) {
        this.sendVoiceError("VOICE_RATE_LIMITED", VOICE_SESSION_LIMIT.message, sessionId)
        return
      }
    }

    const turnDecision = await consumeRateLimit(this.userId, VOICE_TURN_LIMIT)
    if (!turnDecision.allowed) {
      this.sendVoiceError("VOICE_RATE_LIMITED", VOICE_TURN_LIMIT.message, sessionId)
      return
    }

    if (!(await consumeVoiceBudget(1))) {
      this.sendVoiceError(
        "VOICE_CAPACITY_REACHED",
        "Daily voice budget reached. Please try again later.",
        sessionId
      )
      return
    }

    // Day 5 (real mode): open the Deepgram upstream BEFORE the utterance
    // accepts a single byte of audio. A failed handshake has already sent
    // its own voice_error — the utterance never starts.
    if (!env.VOICE_MOCK) {
      const opened = await this.openUpstream(sessionId)
      if (!opened) {
        return
      }
    }
    this.utteranceStartedAtMs = Date.now()

    if (isRestart && existing !== null) {
      // New utterance inside the same session: reset the per-utterance
      // counters, keep the session clock AND the STT charge state (the
      // carried byte remainder must survive across utterances).
      existing.utteranceOpen = true
      existing.bytesReceived = 0
      existing.droppedFrames = 0
      return
    }

    this.voiceSession = {
      sessionId,
      startedAtMs: Date.now(),
      utteranceOpen: true,
      bytesReceived: 0,
      droppedFrames: 0,
      sttForwardedBytes: 0,
      sttChargedUnits: 0,
    }
    logRagEvent("agent_step", "Voice session started", {
      service: "AgentWsHandler",
      sessionId,
      userId: this.userId,
    })
  }

  /** voice_end: close the utterance; the 10-minute session survives. */
  private async handleVoiceEnd(sessionId: string): Promise<void> {
    const session = this.voiceSession
    if (session === null || session.sessionId !== sessionId || !session.utteranceOpen) {
      this.sendVoiceError("NO_VOICE_SESSION", "voice_end without an open utterance.", sessionId)
      return
    }
    session.utteranceOpen = false
    logRagEvent("agent_step", "Voice utterance ended", {
      service: "AgentWsHandler",
      sessionId,
      userId: this.userId ?? "unauthenticated",
      bytesReceived: session.bytesReceived,
    })

    // Day 5 rule 2: voice_end → Finalize (flush), wait for the final
    // transcript, then CloseStream then close. The final itself arrives via
    // the stream's onFinal callback (transcript_final + persist).
    const stream = this.deepgram
    if (stream !== null) {
      try {
        await stream.finalize()
      } catch (error: unknown) {
        logError("Voice finalize failed", error, {
          service: "AgentWsHandler",
          sessionId,
        })
      }
      this.closeUpstream()
    }
  }

  /**
   * barge_in (Day 3a): accepted as a no-op while the session exists —
   * there is no TTS to stop yet (Day 7). Unknown sessions are ignored so a
   * stale barge_in after teardown cannot surface a spurious error.
   */
  private handleBargeIn(sessionId: string): void {
    const session = this.voiceSession
    if (session !== null && session.sessionId === sessionId) {
      logRagEvent("agent_step", "Voice barge-in received", {
        service: "AgentWsHandler",
        sessionId,
        userId: this.userId ?? "unauthenticated",
      })
    }
  }

  // ── Deepgram upstream (Day 5) ───────────────────────────────────────────

  /**
   * Open the upstream for this utterance (real mode only). Order matters:
   *   1. breaker must be available (fail fast when open)
   *   2. connect with the classified handshake
   *   3. only then claim the per-user slot — a failed handshake never
   *      displaces a working stream from another connection
   * A displaced stream is CloseStream+closed and its owner is told to tear
   * down (Day 5 rule 2: one live upstream per user).
   */
  private async openUpstream(sessionId: string): Promise<boolean> {
    const userId = this.userId
    if (userId === null) return false

    if (!sttBreaker.isAvailable()) {
      this.sendVoiceError(
        "PROVIDER_UNAVAILABLE",
        "Speech provider unavailable — please retry shortly.",
        sessionId
      )
      return false
    }

    // Close any leftover stream this connection still owns (e.g. a failed
    // finalize) before registering the new one — self-displacement would
    // otherwise tear down our own session.
    if (this.deepgram !== null) {
      unregisterUpstream(userId, this.deepgram)
      this.deepgram.close()
      this.deepgram = null
    }

    const stream = new DeepgramStream({
      url: buildListenUrl(env.DEEPGRAM_WS_URL, env.DEEPGRAM_MODEL),
      apiKey: env.DEEPGRAM_API_KEY ?? "",
      sessionId,
      onFinal: (text, meta) => {
        const latencyMs = Math.max(0, Date.now() - this.utteranceStartedAtMs)
        const complete = meta.reason === "finalized"
        this.send({ type: "transcript_final", sessionId, text, latencyMs, complete })
        logRagEvent("agent_step", "Voice final transcript received", {
          service: "AgentWsHandler",
          sessionId,
          userId,
          latencyMs,
          reason: meta.reason,
        })
        void saveVoiceTranscript({ userId, sessionId, text, latencyMs }).catch((error: unknown) => {
          logError("Saving voice transcript failed", error, {
            service: "AgentWsHandler",
            sessionId,
          })
        })
        if (complete) {
          void this.handleStart(text, sessionId, "voice").catch((error: unknown) => {
            logError("Voice-origin agent start failed", error, {
              service: "AgentWsHandler",
              sessionId,
              userId,
            })
          })
        } else {
          this.sendVoiceError(
            "TRANSCRIPT_INCOMPLETE",
            "I didn't catch all of that — please try again.",
            sessionId
          )
        }
      },
      onFailure: failure => {
        if (failure.action === "count") {
          sttBreaker.recordFailure()
        }
        if (this.deepgram === stream) {
          this.deepgram = null
        }
        unregisterUpstream(userId, stream)
        const session = this.voiceSession
        if (session !== null && session.sessionId === sessionId) {
          session.utteranceOpen = false
        }
        const providerDown = failure.action === "count" && !sttBreaker.isAvailable()
        this.sendVoiceError(
          providerDown ? "PROVIDER_UNAVAILABLE" : "STT_FAILED",
          failure.message,
          sessionId
        )
      },
    })

    try {
      await stream.connect()
    } catch (error: unknown) {
      stream.close()
      const status = error instanceof DeepgramHandshakeError ? error.status : null
      const outcome = classifyHandshakeStatus(status)
      logError("Deepgram handshake failed", error, {
        service: "AgentWsHandler",
        sessionId,
        handshakeStatus: status ?? "network",
        outcome,
      })
      if (outcome === "quota") {
        // 402: the provider cap is spent — open now, surface the budget
        // code (never PROVIDER_UNAVAILABLE — this is not an outage).
        sttBreaker.tripOpen()
        this.sendVoiceError(
          "VOICE_BUDGET_REACHED",
          "Speech provider quota reached — voice resumes when the cap resets.",
          sessionId
        )
      } else if (outcome === "ignore") {
        // 401/429/other 4xx: client-side condition — breaker untouched.
        this.sendVoiceError(
          "STT_FAILED",
          status === 401
            ? "Speech provider rejected the server credentials."
            : status === 429
              ? "Speech provider rate-limited the connection — try again shortly."
              : `Speech provider refused the connection (HTTP ${status ?? "unknown"}).`,
          sessionId
        )
      } else {
        sttBreaker.recordFailure()
        const providerDown = !sttBreaker.isAvailable()
        this.sendVoiceError(
          providerDown ? "PROVIDER_UNAVAILABLE" : "STT_FAILED",
          providerDown
            ? "Speech provider unavailable — please retry shortly."
            : "Could not connect to the speech provider.",
          sessionId
        )
      }
      return false
    }

    // Connected: claim the per-user slot (single-threaded — no await here,
    // so registration and displacement are atomic).
    const displaced = registerUpstream(userId, {
      stream,
      superseded: () => this.handleSuperseded(sessionId),
    })
    if (displaced !== null) {
      displaced.stream.close()
      displaced.superseded()
    }
    this.deepgram = stream
    sttBreaker.recordSuccess()
    logRagEvent("agent_step", "Deepgram stream opened", {
      service: "AgentWsHandler",
      sessionId,
      userId,
    })
    return true
  }

  /** A newer connection from this user took over — drop our voice state. */
  private handleSuperseded(sessionId: string): void {
    this.deepgram = null
    this.voiceSession = null
    this.sendVoiceError(
      "NO_VOICE_SESSION",
      "Voice session superseded by a newer connection.",
      sessionId
    )
  }

  /**
   * Close path for every non-fatal teardown (client close, voice_end,
   * session/utterance caps, supersede, shutdown): CloseStream then close.
   * Idempotent — clears our reference first so re-entry is a no-op.
   */
  private closeUpstream(): void {
    const stream = this.deepgram
    if (stream === null) return
    this.deepgram = null
    if (this.userId !== null) {
      unregisterUpstream(this.userId, stream)
    }
    stream.close()
  }

  /**
   * Binary audio frame. Order matters (Day 3a spec):
   *   1. reject before auth completes   2. require an open utterance
   *   3. frame ≤4096 B                  4. session ≤10 min
   *   5. pacing — drop frames faster than real time   6. utterance ≤60 s of bytes
   * The utterance cap counts BYTES (32 000 B/s), not wall time, so it holds
   * regardless of how the client spaces frames.
   */
  private async handleAudioFrame(bytes: Buffer): Promise<void> {
    if (this.userId === null) {
      this.sendVoiceError("NOT_AUTHENTICATED", "Authenticate before sending audio.")
      return
    }

    const session = this.voiceSession
    if (session === null || !session.utteranceOpen) {
      this.sendVoiceError("NO_VOICE_SESSION", "Send voice_start before audio frames.")
      return
    }

    if (bytes.length > VOICE_MAX_FRAME_BYTES) {
      this.sendVoiceError(
        "FRAME_TOO_LARGE",
        `Audio frames must be ${VOICE_MAX_FRAME_BYTES} bytes or smaller.`
      )
      return
    }

    const nowMs = Date.now()

    if (nowMs - session.startedAtMs > VOICE_MAX_SESSION_MS) {
      this.voiceSession = null
      // Day 5 rule 2: session cap → CloseStream then close.
      this.closeUpstream()
      this.sendVoiceError(
        "SESSION_LIMIT",
        `Voice session exceeded ${VOICE_MAX_SESSION_MS / 60_000} minutes.`
      )
      return
    }

    // Pacing: allow a 2-second burst, then require ~real-time arrival.
    const elapsedMs = nowMs - session.startedAtMs
    const allowedBytes = elapsedMs * PCM_BYTES_PER_MS + PACE_BURST_BYTES
    if (session.bytesReceived + bytes.length > allowedBytes) {
      session.droppedFrames += 1
      logRagEvent("agent_step", "Voice audio frame dropped (faster than real time)", {
        service: "AgentWsHandler",
        sessionId: session.sessionId,
        userId: this.userId,
        droppedFrames: session.droppedFrames,
      })
      return
    }

    if (session.bytesReceived + bytes.length > MAX_UTTERANCE_BYTES) {
      // Utterance over: stop accepting audio until the next voice_start;
      // the session itself survives (client may start a fresh utterance).
      session.utteranceOpen = false
      // Day 5: the stream lived for this utterance — close it too.
      this.closeUpstream()
      this.sendVoiceError(
        "UTTERANCE_TOO_LONG",
        `Utterance exceeds ${VOICE_MAX_UTTERANCE_MS / 1000} seconds of audio.`
      )
      return
    }

    session.bytesReceived += bytes.length

    // Day 5 (real mode): charge the voice budget 1 unit per 30 s of audio
    // accepted for upstream forwarding — ceil(total forwarded ÷ 960 000 B).
    // The total is session-scoped: sub-unit byte remainders carry across
    // utterances, so a short utterance never buys a second unit for audio
    // the session already paid for, and fractional seconds are never floored
    // away (an 8 s utterance charges exactly 1 unit). Rejected frames
    // (oversized, paced out, over the caps — all handled above) never reach
    // this accumulator. The charge happens BEFORE the frame is sent: a
    // refused charge stops the utterance with the boundary-crossing frame
    // still unsent, so Deepgram's bill can never exceed charged units.
    if (!env.VOICE_MOCK) {
      const stream = this.deepgram
      if (stream === null) {
        // Invariant: a live utterance in real mode owns a live upstream.
        session.utteranceOpen = false
        this.sendVoiceError("STT_FAILED", "Speech stream is not connected.", session.sessionId)
        return
      }

      const dueUnits = Math.ceil((session.sttForwardedBytes + bytes.length) / STT_BYTES_PER_UNIT)
      const toCharge = dueUnits - session.sttChargedUnits
      if (toCharge > 0) {
        if (!(await consumeVoiceBudget(toCharge))) {
          // Fail closed mid-utterance: refuse the spend, stop the stream.
          // Counters stay put — the same unit would be retried against a
          // budget that keeps refusing, and the frame below is never sent.
          session.utteranceOpen = false
          this.closeUpstream()
          this.sendVoiceError(
            "VOICE_CAPACITY_REACHED",
            "Voice budget reached mid-utterance.",
            session.sessionId
          )
          return
        }
        session.sttChargedUnits = dueUnits
      }

      session.sttForwardedBytes += bytes.length
      stream.sendAudio(bytes)
    }
  }

  /** Whether completed answers are spoken on this connection (set_speak). */
  isSpeakEnabled(): boolean {
    return this.speakEnabled
  }

  /** Voice counters for diagnostics and Day 11 metrics. */
  getVoiceDiagnostics(): {
    sessionId: string | null
    utteranceOpen: boolean
    startedAtMs: number
    bytesReceived: number
    droppedFrames: number
    sttForwardedBytes: number
    sttChargedUnits: number
  } {
    const session = this.voiceSession
    if (session === null) {
      return {
        sessionId: null,
        utteranceOpen: false,
        startedAtMs: 0,
        bytesReceived: 0,
        droppedFrames: 0,
        sttForwardedBytes: 0,
        sttChargedUnits: 0,
      }
    }
    return {
      sessionId: session.sessionId,
      utteranceOpen: session.utteranceOpen,
      startedAtMs: session.startedAtMs,
      bytesReceived: session.bytesReceived,
      droppedFrames: session.droppedFrames,
      sttForwardedBytes: session.sttForwardedBytes,
      sttChargedUnits: session.sttChargedUnits,
    }
  }

  // ── Auth Timeout Helper ────────────────────────────────────────────────
  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer)
      this.authTimer = null
    }
  }

  // ── Send Helper ────────────────────────────────────────────────────────
  // Type-safe wrapper around ws.send().
  // Never throws — if the connection is closed, the send is silently dropped.
  private send(message: ServerMessage): void {
    try {
      if (this.ws.readyState === 1) {
        // 1 = WebSocket.OPEN
        this.ws.send(toJson(message))
      }
    } catch (error: unknown) {
      logError("Failed to send WebSocket message", error, {
        service: "AgentWsHandler",
      })
    }
  }
}
