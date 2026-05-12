// backend/jest.config.mjs (ESM)

/** @type {import('jest').Config} */
export default {
  preset: "ts-jest",
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

  // Correct property name
  setupFilesAfterFramework: ["<rootDir>/src/__tests__/helpers/setup.ts"],

  verbose: true,

  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/types/**",
    "!src/app.ts",
    "!src/**/*.d.ts",
    "!src/scripts/**",
    "!src/database/**"
  ],

  coverageThreshold: {
    global: {
      lines: 80,
      functions: 80,
      branches: 70,
      statements: 80
    },
    "./src/services/chunking.service.ts": {
      lines: 95, functions: 95
    },
    "./src/services/embedding.service.ts": {
      lines: 85, functions: 85
    },
    "./src/services/generation.service.ts": {
      lines: 80, functions: 80
    }
  },

  clearMocks: true,
  resetMocks: false,
  restoreMocks: false
}