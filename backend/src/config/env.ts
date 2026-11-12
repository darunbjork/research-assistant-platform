// backend/src/config/env.ts
//
// Single source of truth for configuration. process.env is parsed ONCE at
// import time; every module reads the frozen `env` object instead of
// touching process.env directly, so a typo or missing variable fails at
// startup with a clear message instead of surfacing as a runtime surprise
// (D16, task 3.1).
//
// Failure output lists the offending variable NAMES only — never their
// values, which may be secrets.
/* eslint-disable no-console */

import { z } from "zod"

/** Treat empty strings in .env files as "not set". */
const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value)

export const envSchema = z
  .object({
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      z.enum(["development", "test", "production"]).default("development")
    ),
    PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(3001)),
    DATABASE_URL: z.preprocess(emptyToUndefined, z.url()),
    REDIS_URL: z.preprocess(emptyToUndefined, z.url()),
    GEMINI_API_KEY: z.preprocess(emptyToUndefined, z.string().min(20)),
    GEMINI_GENERATION_MODEL: z.preprocess(
      emptyToUndefined,
      z.string().min(1).default("gemini-3.6-flash")
    ),
    GEMINI_EMBEDDING_MODEL: z.preprocess(
      emptyToUndefined,
      z.string().min(1).default("gemini-embedding-001")
    ),
    GEMINI_TIMEOUT_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().default(30000)
    ),
    JWT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32)),
    JWT_REFRESH_SECRET: z.preprocess(emptyToUndefined, z.string().min(32)),
    CORS_ORIGINS: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .optional()
        .transform(value =>
          value === undefined
            ? []
            : value
                .split(",")
                .map(origin => origin.trim())
                .filter(origin => origin.length > 0)
        )
    ),
    ALLOW_REGISTRATION: z.preprocess(
      value => {
        if (value === undefined || value === "") return undefined
        return typeof value === "string" ? value.trim().toLowerCase() : value
      },
      z
        .enum(["true", "false"])
        .default("true")
        .transform(flag => flag === "true")
    ),
    GLOBAL_DAILY_LLM_CALLS_MAX: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().default(2000)
    ),
    METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(24).optional()),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(["error", "warn", "info", "http", "verbose", "debug", "silly"]).default("info")
    ),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
    OTEL_SERVICE_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
    // ── Voice layer (Deepgram STT / ElevenLabs TTS) — Day 1 ──────────────
    // VOICE_MOCK=true (default) makes every provider call a deterministic
    // in-process stub: no network, no billing. Keys are required only when
    // VOICE_MOCK=false (superRefine below). Complete the spend-cap checklist
    // in docs/cost.md before ever flipping this off.
    VOICE_MOCK: z.preprocess(
      value => {
        if (value === undefined || value === "") return undefined
        return typeof value === "string" ? value.trim().toLowerCase() : value
      },
      z
        .enum(["true", "false"])
        .default("true")
        .transform(flag => flag === "true")
    ),
    DEEPGRAM_API_KEY: z.preprocess(emptyToUndefined, z.string().min(10).optional()),
    DEEPGRAM_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).default("nova-3")),
    ELEVENLABS_API_KEY: z.preprocess(emptyToUndefined, z.string().min(10).optional()),
    ELEVENLABS_MODEL_ID: z.preprocess(
      emptyToUndefined,
      z.string().min(1).default("eleven_flash_v2_5")
    ),
    ELEVENLABS_VOICE_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  })
  .superRefine((value, ctx) => {
    if (value.JWT_SECRET === value.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: "custom",
        message: "JWT_SECRET and JWT_REFRESH_SECRET must be different",
        path: ["JWT_REFRESH_SECRET"],
      })
    }
    if (value.NODE_ENV === "production" && value.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "CORS_ORIGINS is required in production (comma-separated origins)",
        path: ["CORS_ORIGINS"],
      })
    }
    // Real voice mode needs all three credentials; mock mode needs none.
    if (!value.VOICE_MOCK) {
      if (!value.DEEPGRAM_API_KEY) {
        ctx.addIssue({
          code: "custom",
          message: "DEEPGRAM_API_KEY is required when VOICE_MOCK=false",
          path: ["DEEPGRAM_API_KEY"],
        })
      }
      if (!value.ELEVENLABS_API_KEY) {
        ctx.addIssue({
          code: "custom",
          message: "ELEVENLABS_API_KEY is required when VOICE_MOCK=false",
          path: ["ELEVENLABS_API_KEY"],
        })
      }
      if (!value.ELEVENLABS_VOICE_ID) {
        ctx.addIssue({
          code: "custom",
          message: "ELEVENLABS_VOICE_ID is required when VOICE_MOCK=false",
          path: ["ELEVENLABS_VOICE_ID"],
        })
      }
    }
  })

export type Env = z.infer<typeof envSchema>

/**
 * Validate `source` and return a frozen env object. On failure print which
 * variables are wrong (names only — never values) and exit with code 1.
 */
export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source)
  if (!result.success) {
    console.error("Invalid environment configuration — fix these variables (values are hidden):")
    for (const issue of result.error.issues) {
      const name = issue.path.length > 0 ? issue.path.join(".") : "(root)"
      const detail = issue.code === "custom" ? issue.message : issue.code
      console.error(`  - ${name}: ${detail}`)
    }
    process.exit(1)
  }
  return Object.freeze(result.data)
}

// Parsed once at import. app.ts imports this immediately after preload-env,
// and every test setup file fills process.env with valid values first.
export const env: Env = loadEnv(process.env)
