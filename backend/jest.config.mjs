export default {
  preset:          "ts-jest",
  testEnvironment: "node",

  testMatch: [
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.spec.ts"
  ],

  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "/__tests__/helpers/",
    "/__integration__/"
  ],

  // Registered in jest.config.mjs via setupFilesAfterEnv.
  setupFilesAfterEnv: ["<rootDir>/src/__tests__/helpers/setup.ts"],

  // ── FIXES EADDRINUSE ──────────────────────────────────────────────────────
  // Kills any lingering processes after the test suite finishes
  forceExit:   true,
  // Clears all mocks between tests — prevents state leakage
  clearMocks:  true,
  resetMocks:  false,
  restoreMocks: false,

  verbose: true,

  // Global timeout — generous for tests that await async operations
  testTimeout: 10000,

  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/types/**",
    "!src/app.ts",
    "!src/**/*.d.ts",
    "!src/scripts/**",
    // Integration tests run against a real DB under jest.integration.config.mjs
    // and are not part of the unit coverage measurement.
    "!src/__integration__/**"
  ],

  // Task 5.8: Phase 0 baseline (61.43/52.53/59.43/61.67) rounded down.
  // Raise step by step — never lower.
  coverageThreshold: {
    global: {
      statements: 61,
      branches: 52,
      functions: 59,
      lines: 61
    }
  }
}