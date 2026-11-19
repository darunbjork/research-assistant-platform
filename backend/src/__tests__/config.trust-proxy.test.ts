// backend/src/__tests__/config.trust-proxy.test.ts
//
// K3S plan B1: TRUST_PROXY_HOPS decides how many X-Forwarded-For entries
// Express trusts. req.ip drives the IP-based auth rate limits (D20), so a
// wrong value either lumps every client behind the proxy's IP (too low) or
// lets a client spoof its address (too high).

import type { AddressInfo } from "net"
import express, { type Request, type Response } from "express"
import { envSchema } from "../config/env"

const VALID = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/ragdb",
  REDIS_URL: "redis://localhost:6379",
  GEMINI_API_KEY: "test-key-not-a-real-secret",
  JWT_SECRET: "test-jwt-secret-32-chars-minimum-abcdef",
  JWT_REFRESH_SECRET: "test-refresh-secret-32-chars-minimum-xyz",
}

/** An app wired exactly like app.ts: trust proxy = the parsed env value. */
function appWithHops(raw: string | undefined): express.Express {
  const parsed = envSchema.parse({ ...VALID, TRUST_PROXY_HOPS: raw })
  const app = express()
  app.set("trust proxy", parsed.TRUST_PROXY_HOPS)
  app.get("/ip", (req: Request, res: Response): void => {
    res.json({ ip: req.ip })
  })
  return app
}

/** Start the app on a random port, send one request, return the req.ip it saw. */
async function ipSeenBy(app: express.Express, forwardedFor: string): Promise<string> {
  const server = await new Promise<import("http").Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
  })
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/ip`, {
      headers: { "X-Forwarded-For": forwardedFor },
    })
    const body = (await res.json()) as { ip: string }
    return body.ip
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe("TRUST_PROXY_HOPS env", () => {
  it("defaults to 1 (one proxy: Caddy in compose, Traefik on k3s)", () => {
    const result = envSchema.safeParse(VALID)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.TRUST_PROXY_HOPS).toBe(1)
  })

  it("treats an empty string as unset", () => {
    const result = envSchema.safeParse({ ...VALID, TRUST_PROXY_HOPS: "" })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.TRUST_PROXY_HOPS).toBe(1)
  })

  it.each([
    ["0", false],
    ["1", true],
    ["2", true],
    ["3", true],
    ["4", false],
    ["1.5", false],
    ["abc", false],
  ])("validates TRUST_PROXY_HOPS=%s → %s", (value, ok) => {
    expect(envSchema.safeParse({ ...VALID, TRUST_PROXY_HOPS: value }).success).toBe(ok)
  })
})

describe("trust proxy wiring", () => {
  it("1 hop: req.ip is the client address the proxy appended", async () => {
    expect(await ipSeenBy(appWithHops("1"), "203.0.113.7")).toBe("203.0.113.7")
  })

  it("1 hop: a client-forged X-Forwarded-For entry is ignored", async () => {
    // The client sent "198.51.100.1"; the single trusted proxy appended the
    // real address. Only the rightmost (proxy-written) entry is trusted.
    expect(await ipSeenBy(appWithHops("1"), "198.51.100.1, 203.0.113.7")).toBe("203.0.113.7")
  })

  it("2 hops: req.ip skips the inner proxy's entry", async () => {
    expect(await ipSeenBy(appWithHops("2"), "203.0.113.7, 10.42.0.15")).toBe("203.0.113.7")
  })
})
