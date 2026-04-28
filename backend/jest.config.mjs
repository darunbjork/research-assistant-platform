// * Jest configuration for TypeScript projects.
// * ts-jest transforms TypeScript files before Jest runs them.

import { fileURLToPath } from 'url';
import path from 'path';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('jest').Config} */
const jestConfig = {
  // Use ts-jest to handle TypeScript files
  preset: "ts-jest",

  // Run in Node.js environment (not browser)
  testEnvironment: "node",

  // Where to find test files
  // This pattern matches: src/foo.test.ts, src/__tests__/foo.ts
  testMatch: [
    "**/__tests__/**/*.ts",
    "**/*.test.ts"
  ],

  // Do not look for tests in these folders
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/"
  ],

  // Show individual test names in output (not just pass/fail totals)
  verbose: true,

  // Coverage configuration — used by npm run test:coverage
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/types/**",      // type definitions are not testable logic
    "!src/app.ts",        // app startup is tested via integration tests
    "!src/**/*.d.ts"      // declaration files
  ],

  // Coverage thresholds — the build fails if coverage drops below these
  // We start at 50% and raise it as we add more services
  coverageThreshold: {
    global: {
      lines:     50,
      functions: 50,
      branches:  40,
      statements: 50
    }
  }
};

export default jestConfig;
