// backend/src/__tests__/metrics.auth.test.ts
//
// D19 (task 2.7): when METRICS_TOKEN is set, both /metrics routes require
// `Authorization: Bearer <METRICS_TOKEN>` and answer 404 otherwise (404, not
// 401, so the endpoint is not advertised). Without the token the routes stay
// open — Caddy (task 5.3) is the outer layer that stops routing them.
//
// env is parsed once at import (task 3.1), so this file mocks config/env
// with a mutable copy to flip METRICS_TOKEN between requests.

jest.mock("../config/env", () => {
  const actual = jest.requireActual("../config/env") as typeof import("../config/env")
  return { ...actual, env: { ...actual.env } }
})

const metricsRoutes = require("../routes/metrics.routes").default as import("express").Router
const { env } = require("../config/env") as typeof import("../config/env")

describe("/metrics token guard (D19)", () => {
  let server: import("http").Server
  let baseUrl: string

  beforeAll(async () => {
    const express = require("express") as typeof import("express")
    const app = express()
    app.use("/", metricsRoutes)

    await new Promise<void>(resolve => {
      server = app.listen(0, () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new Error("Could not determine test server port")
    }
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  beforeEach(() => {
    env.METRICS_TOKEN = undefined
  })

  const get = async (path: string, authorization?: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      headers: authorization !== undefined ? { Authorization: authorization } : {},
    })

  it("stays open when METRICS_TOKEN is not set", async () => {
    const res = await get("/metrics")
    expect(res.status).toBe(200)

    const jsonRes = await get("/metrics/json")
    expect(jsonRes.status).toBe(200)
  })

  it("accepts the correct Bearer token when METRICS_TOKEN is set", async () => {
    env.METRICS_TOKEN = "test-metrics-token-0123456789abcdef"

    const res = await get("/metrics", "Bearer test-metrics-token-0123456789abcdef")
    expect(res.status).toBe(200)

    const jsonRes = await get("/metrics/json", "Bearer test-metrics-token-0123456789abcdef")
    expect(jsonRes.status).toBe(200)
  })

  it("returns 404 (not 401) for a missing token", async () => {
    env.METRICS_TOKEN = "test-metrics-token-0123456789abcdef"

    const res = await get("/metrics")
    expect(res.status).toBe(404)

    const jsonRes = await get("/metrics/json")
    expect(jsonRes.status).toBe(404)
  })

  it("returns 404 for a wrong token", async () => {
    env.METRICS_TOKEN = "test-metrics-token-0123456789abcdef"

    const res = await get("/metrics", "Bearer wrong-token")
    expect(res.status).toBe(404)
  })

  it("returns 404 for a non-Bearer Authorization scheme", async () => {
    env.METRICS_TOKEN = "test-metrics-token-0123456789abcdef"

    const res = await get("/metrics", "Basic dXNlcjpwYXNz")
    expect(res.status).toBe(404)
  })
})

export {}
