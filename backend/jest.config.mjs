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
    "/__tests__/helpers/"
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
    "!src/scripts/**"
  ],

  // TODO: raise to 80/70/80/80 after adding tests for
  // src/routes, src/controllers, and src/middleware
  // (currently at 0% coverage).
  coverageThreshold: {
    global: {
      statements: 60,
      branches: 50,
      functions: 55,
      lines: 60
    }
  }
}