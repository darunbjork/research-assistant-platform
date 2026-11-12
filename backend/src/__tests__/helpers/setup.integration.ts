// Integration-test environment bootstrap (setupFilesAfterEnv).
//
// Runs before the test files evaluate, so src/config/env.ts sees valid
// values when it parses process.env at import time.
//
// Order matters: test-safe defaults FIRST, then dotenv — dotenv never
// overrides values that are already set, so the real GEMINI/JWT secrets in
// .env never enter the test process. DATABASE_URL / REDIS_URL come from
// .env (these tests talk to the real containers).
import dotenv from "dotenv"

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-key-not-a-real-secret"
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-32-chars-minimum-abcdef"
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret-32-chars-minimum-xyz"

dotenv.config()
