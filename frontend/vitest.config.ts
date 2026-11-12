// frontend/vitest.config.ts
// Frontend unit tests run on Vitest; the backend keeps its own Jest setup
// (backend/jest.config.mjs). The two never mix — different packages,
// different module systems (frontend is ESM, backend is CommonJS).
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The hooks touch browser globals (WebSocket, localStorage, location),
    // which Node's environment does not provide.
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
