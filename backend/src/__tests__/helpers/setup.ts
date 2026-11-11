/* eslint-disable no-console */

// Valid values for every variable required by src/config/env.ts, set BEFORE
// any test file (or its imports) parses process.env. Tests must not depend
// on .env — these defaults keep the suite hermetic.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test"
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/rag_test"
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-key-not-a-real-secret"
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-32-chars-minimum-abcdef"
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret-32-chars-minimum-xyz"

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  debug: console.debug,
}

beforeAll(() => {
  console.log = jest.fn()
  console.info = jest.fn()
  console.warn = jest.fn()
  console.debug = jest.fn()
})

afterAll(() => {
  console.log = originalConsole.log
  console.info = originalConsole.info
  console.warn = originalConsole.warn
  console.debug = originalConsole.debug
})

jest.setTimeout(10_000)
