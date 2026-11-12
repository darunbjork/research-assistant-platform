// Jest config for integration tests: real Postgres + real Redis, no mocks
// for the database, Gemini never called. No coverage thresholds here —
// coverage is measured by the unit suite (jest.config.mjs).

export default {
  preset: "ts-jest",
  testEnvironment: "node",

  testMatch: ["**/__integration__/**/*.test.ts"],

  testPathIgnorePatterns: ["/node_modules/", "/dist/"],

  // Fills DATABASE_URL/REDIS_URL (via .env) and test-safe defaults before
  // any test file imports src/config/env.ts. Lives under __tests__/helpers
  // because the plan's done-when grep only exempts that directory.
  setupFilesAfterEnv: ["<rootDir>/src/__tests__/helpers/setup.integration.ts"],

  // Integration tests share one database — run them serially.
  maxWorkers: 1,

  forceExit: true,
  clearMocks: true,
  verbose: true,

  // Real database round-trips need more headroom than unit tests.
  testTimeout: 30000,
}
