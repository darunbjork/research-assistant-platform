// backend/src/__tests__/livez.routes.test.ts
//
// K3S plan: the liveness probe hits /livez, which must answer without
// touching Postgres or Redis (unlike /health, the readiness probe).

import type { AddressInfo } from "net"
import type { Server } from "http"
import express from "express"

const mockQueryRaw = jest.fn()
jest.mock("../utils/prisma", () => ({ prisma: { $queryRaw: mockQueryRaw } }))
const mockRedisHealth = jest.fn()
jest.mock("../utils/redis", () => ({ checkRedisHealth: mockRedisHealth }))

import livezRouter from "../routes/livez.routes"

describe("GET /livez", () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    const app = express()
    app.use("/", livezRouter)
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
    })
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it("returns 200 without checking the database or Redis", async () => {
    const res = await fetch(`${baseUrl}/livez`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(mockQueryRaw).not.toHaveBeenCalled()
    expect(mockRedisHealth).not.toHaveBeenCalled()
  })

  it("only answers GET /livez", async () => {
    expect((await fetch(`${baseUrl}/livez`, { method: "POST" })).status).toBe(404)
    expect((await fetch(`${baseUrl}/livez/extra`)).status).toBe(404)
  })
})
