// backend/src/__tests__/config.env.test.ts
//
// Task 3.1 (D16): the Zod env schema must fail fast on bad configuration —
// a missing key, duplicate JWT secrets, production without CORS_ORIGINS —
// and when it fails it must print variable NAMES only, never their values
// (they may be secrets).

import { envSchema, loadEnv } from "../config/env"

// A complete, valid environment. Tests derive from this and break one thing.
const VALID = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/ragdb",
  REDIS_URL: "redis://localhost:6379",
  GEMINI_API_KEY: "test-key-not-a-real-secret",
  JWT_SECRET: "test-jwt-secret-32-chars-minimum-abcdef",
  JWT_REFRESH_SECRET: "test-refresh-secret-32-chars-minimum-xyz",
}

describe("env schema", () => {
  it("fails when a required key is missing", () => {
    const result = envSchema.safeParse({ ...VALID, GEMINI_API_KEY: undefined })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some(issue => issue.path.includes("GEMINI_API_KEY"))).toBe(true)
  })

  it("fails when JWT_SECRET and JWT_REFRESH_SECRET are identical", () => {
    const result = envSchema.safeParse({ ...VALID, JWT_REFRESH_SECRET: VALID.JWT_SECRET })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some(issue => issue.path.includes("JWT_REFRESH_SECRET"))).toBe(true)
  })

  it("fails when a secret is shorter than 32 characters", () => {
    const result = envSchema.safeParse({ ...VALID, JWT_SECRET: "too-short" })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some(issue => issue.path.includes("JWT_SECRET"))).toBe(true)
  })

  it("fails in production without CORS_ORIGINS", () => {
    const result = envSchema.safeParse({ ...VALID, NODE_ENV: "production" })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some(issue => issue.path.includes("CORS_ORIGINS"))).toBe(true)
  })

  it("passes a valid env and applies every documented default", () => {
    const result = envSchema.safeParse(VALID)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data).toMatchObject({
      NODE_ENV: "development",
      PORT: 3001,
      GEMINI_GENERATION_MODEL: "gemini-3.6-flash",
      GEMINI_EMBEDDING_MODEL: "gemini-embedding-001",
      GEMINI_TIMEOUT_MS: 30000,
      GLOBAL_DAILY_LLM_CALLS_MAX: 2000,
      LOG_LEVEL: "info",
      ALLOW_REGISTRATION: true,
      CORS_ORIGINS: [],
    })
    expect(result.data.METRICS_TOKEN).toBeUndefined()
  })

  it("parses comma-separated CORS_ORIGINS into a list", () => {
    const result = envSchema.safeParse({
      ...VALID,
      CORS_ORIGINS: "https://a.example.com, https://b.example.com",
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.CORS_ORIGINS).toEqual(["https://a.example.com", "https://b.example.com"])
  })

  it("parses ALLOW_REGISTRATION strings into booleans", () => {
    const closed = envSchema.safeParse({ ...VALID, ALLOW_REGISTRATION: "false" })
    expect(closed.success).toBe(true)
    if (closed.success) expect(closed.data.ALLOW_REGISTRATION).toBe(false)

    const open = envSchema.safeParse({ ...VALID, ALLOW_REGISTRATION: "true" })
    expect(open.success).toBe(true)
    if (open.success) expect(open.data.ALLOW_REGISTRATION).toBe(true)
  })

  it("rejects a non-numeric PORT", () => {
    const result = envSchema.safeParse({ ...VALID, PORT: "not-a-port" })
    expect(result.success).toBe(false)
  })

  it("treats an empty METRICS_TOKEN as unset", () => {
    const result = envSchema.safeParse({ ...VALID, METRICS_TOKEN: "" })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.METRICS_TOKEN).toBeUndefined()
  })

  it("rejects a non-string ALLOW_REGISTRATION", () => {
    const result = envSchema.safeParse({ ...VALID, ALLOW_REGISTRATION: 7 })
    expect(result.success).toBe(false)
  })
})

describe("loadEnv", () => {
  // Runs loadEnv against a source that must fail, captures what it printed,
  // and restores the process.exit / console.error spies.
  function captureLoadEnvFailure(source: unknown): string {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`)
    }) as never)
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined)
    let printed = ""
    try {
      let exited = false
      try {
        loadEnv(source as NodeJS.ProcessEnv)
      } catch {
        exited = true
      }
      expect(exited).toBe(true)
      printed = errorSpy.mock.calls.flat().join("\n")
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
    }
    return printed
  }

  it("prints variable names — never their values — and exits with code 1", () => {
    const secretValue = "SuperSecretValueMustNotPrint" // 28 chars → fails min 32
    const printed = captureLoadEnvFailure({
      ...VALID,
      JWT_SECRET: secretValue, // too short → fails min 32
      GEMINI_API_KEY: undefined, // missing → fails required
    })

    expect(printed).toContain("JWT_SECRET")
    expect(printed).toContain("GEMINI_API_KEY")
    expect(printed).not.toContain(secretValue)
  })

  it("prints the custom message for a schema refinement failure", () => {
    const printed = captureLoadEnvFailure({ ...VALID, JWT_REFRESH_SECRET: VALID.JWT_SECRET })

    expect(printed).toContain("JWT_REFRESH_SECRET")
    expect(printed).toContain("must be different")
    expect(printed).not.toContain(VALID.JWT_SECRET)
  })

  it("labels issues with no path as (root)", () => {
    const printed = captureLoadEnvFailure(null)

    expect(printed).toContain("(root)")
  })

  it("returns a frozen object for a valid env", () => {
    const env = loadEnv(VALID)
    expect(Object.isFrozen(env)).toBe(true)
    expect(env.PORT).toBe(3001)
  })
})
