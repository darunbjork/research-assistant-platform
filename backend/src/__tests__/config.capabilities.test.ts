// backend/src/__tests__/config.capabilities.test.ts
//
// Voice capability is derived from existing config only, and GET
// /api/v1/config exposes exactly two booleans: nothing about keys,
// models or providers.

import type { AddressInfo } from "net"
import type { Server } from "http"
import express from "express"
import { voiceCapability, serverCapabilities } from "../config/capabilities"

// A mutable env for the route test; the capability function itself is pure.
const mockEnv: { VOICE_MOCK: boolean; TTS_PROVIDER: "mock" | "elevenlabs" } = {
  VOICE_MOCK: true,
  TTS_PROVIDER: "mock",
}
jest.mock("../config/env", () => ({ env: mockEnv }))

import configRouter from "../routes/config.routes"

describe("voiceCapability", () => {
  it.each([
    // VOICE_MOCK, TTS_PROVIDER, expected
    [true, "mock", { stt: false, tts: false }],
    [false, "mock", { stt: true, tts: false }],
    [true, "elevenlabs", { stt: false, tts: true }],
    [false, "elevenlabs", { stt: true, tts: true }],
  ] as const)("VOICE_MOCK=%s, TTS_PROVIDER=%s → %o", (VOICE_MOCK, TTS_PROVIDER, expected) => {
    expect(voiceCapability({ VOICE_MOCK, TTS_PROVIDER })).toEqual(expected)
  })

  it("reports the mock providers as unavailable (production today)", () => {
    expect(serverCapabilities({ VOICE_MOCK: true, TTS_PROVIDER: "mock" })).toEqual({
      voice: { stt: false, tts: false },
    })
  })
})

describe("GET /api/v1/config", () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    const app = express()
    app.use("/api/v1/config", configRouter)
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
    })
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it.each([
    [true, "mock", { stt: false, tts: false }],
    [false, "mock", { stt: true, tts: false }],
    [true, "elevenlabs", { stt: false, tts: true }],
    [false, "elevenlabs", { stt: true, tts: true }],
  ] as const)(
    "VOICE_MOCK=%s, TTS_PROVIDER=%s → voice %o",
    async (VOICE_MOCK, TTS_PROVIDER, expected) => {
      mockEnv.VOICE_MOCK = VOICE_MOCK
      mockEnv.TTS_PROVIDER = TTS_PROVIDER

      const res = await fetch(`${baseUrl}/api/v1/config`)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, data: { voice: expected }, error: null })
    }
  )

  it("exposes only the two voice booleans", async () => {
    mockEnv.VOICE_MOCK = false
    mockEnv.TTS_PROVIDER = "elevenlabs"

    const res = await fetch(`${baseUrl}/api/v1/config`)
    const body = (await res.json()) as { data: Record<string, unknown> }

    expect(Object.keys(body.data)).toEqual(["voice"])
    expect(Object.keys(body.data.voice as object).sort()).toEqual(["stt", "tts"])
    expect(JSON.stringify(body)).not.toMatch(/key|deepgram|elevenlabs|model/i)
    expect(res.headers.get("cache-control")).toBe("public, max-age=60")
  })

  it("is public: no Authorization header needed", async () => {
    const res = await fetch(`${baseUrl}/api/v1/config`)
    expect(res.status).toBe(200)
  })
})
