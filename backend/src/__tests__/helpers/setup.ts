/* eslint-disable no-console */
// backend/src/__tests__/helpers/setup.ts
// Global test setup — runs before every test file.
// Registered in jest.config.js via setupFilesAfterFramework.

// Silence console output during tests to keep test output clean.
// Tests that need to verify logging can spy on the logger directly.
// We keep console.error visible (for unexpected errors that need attention).
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
  // console.error is intentionally NOT mocked — keep it visible
})

afterAll(() => {
  console.log = originalConsole.log
  console.info = originalConsole.info
  console.warn = originalConsole.warn
  console.debug = originalConsole.debug
})

// Extend Jest matchers for better assertions
// (requires jest-extended package)
import "jest-extended"

// Global timeout for async tests involving fake timers
jest.setTimeout(10_000) // 10 seconds max per test
