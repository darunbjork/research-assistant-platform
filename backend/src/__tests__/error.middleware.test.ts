// backend/src/__tests__/error.middleware.test.ts
// Tests for the global error middleware and custom error classes.

import type { Request, Response, NextFunction } from "express"
import express from "express"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { JSON_BODY_LIMIT_BYTES } from "../config/limits"
import {
  errorMiddleware,
  AppError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitError,
  RAGError,
} from "../middleware/error.middleware"

// env is parsed once at import (task 3.1) — mock it with a mutable copy so
// the development/production branches can be flipped per test.
jest.mock("../config/env", () => {
  const actual = jest.requireActual("../config/env") as typeof import("../config/env")
  return { ...actual, env: { ...actual.env } }
})

const { env } = require("../config/env") as typeof import("../config/env")

// ── Helpers ────────────────────────────────────────────────────────────────

function makeReq(): Partial<Request> {
  return { path: "/test", method: "POST" }
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
  return res
}

function makeNext(): NextFunction {
  return jest.fn() as unknown as NextFunction
}

// ── Custom Error Classes ──────────────────────────────────────────────────
describe("Custom Error Classes", () => {
  describe("AppError", () => {
    it("has the correct status code", () => {
      const err = new AppError("test error", 422)
      expect(err.statusCode).toBe(422)
    })

    it("defaults to 500 when no status code given", () => {
      const err = new AppError("test")
      expect(err.statusCode).toBe(500)
    })

    it("is an instance of Error", () => {
      const err = new AppError("test")
      expect(err).toBeInstanceOf(Error)
    })

    it("has a name property", () => {
      const err = new AppError("test")
      expect(err.name).toBe("AppError")
    })
  })

  describe("NotFoundError", () => {
    it("has statusCode 404", () => {
      expect(new NotFoundError("Document").statusCode).toBe(404)
    })

    it("message includes the resource name", () => {
      const err = new NotFoundError("Document")
      expect(err.message).toContain("Document")
    })
  })

  describe("ValidationError", () => {
    it("has statusCode 400", () => {
      expect(new ValidationError("Invalid input").statusCode).toBe(400)
    })
  })

  describe("UnauthorizedError", () => {
    it("has statusCode 401", () => {
      expect(new UnauthorizedError().statusCode).toBe(401)
    })

    it("has a default message", () => {
      const err = new UnauthorizedError()
      expect(err.message.length).toBeGreaterThan(0)
    })
  })

  describe("ForbiddenError", () => {
    it("has statusCode 403", () => {
      expect(new ForbiddenError().statusCode).toBe(403)
    })
  })

  describe("RateLimitError", () => {
    it("has statusCode 429", () => {
      expect(new RateLimitError().statusCode).toBe(429)
    })
  })

  describe("RAGError", () => {
    it("has statusCode 500", () => {
      const err = new RAGError("embedding failed", "embedding")
      expect(err.statusCode).toBe(500)
    })

    it("message includes the step name", () => {
      const err = new RAGError("failed", "chunking")
      expect(err.message).toContain("chunking")
    })
  })
})

// ── Error Middleware ──────────────────────────────────────────────────────
describe("errorMiddleware()", () => {
  it("handles AppError with correct status code", () => {
    const err = new NotFoundError("Document")
    const req = makeReq()
    const res = makeRes()
    const next = makeNext()

    errorMiddleware(err, req as Request, res as unknown as Response, next)

    expect(res.statusCode).toBe(404)
  })

  it("response body has success: false for AppError", () => {
    const err = new ValidationError("Bad input")
    const req = makeReq()
    const res = makeRes()

    errorMiddleware(err, req as Request, res as unknown as Response, makeNext())

    expect((res.body as { success: boolean }).success).toBe(false)
  })

  it("response body contains the error message", () => {
    const err = new ValidationError("Email is required")
    const req = makeReq()
    const res = makeRes()

    errorMiddleware(err, req as Request, res as unknown as Response, makeNext())

    expect((res.body as { error: string }).error).toContain("Email is required")
  })

  it("returns 500 for unknown errors", () => {
    const err = new Error("Unknown crash")
    const req = makeReq()
    const res = makeRes()

    errorMiddleware(err, req as Request, res as unknown as Response, makeNext())

    expect(res.statusCode).toBe(500)
  })

  it("does not expose internal error details in production", () => {
    const savedEnv = env.NODE_ENV
    env.NODE_ENV = "production"

    const err = new Error("Internal secret details")
    const req = makeReq()
    const res = makeRes()

    errorMiddleware(err, req as Request, res as unknown as Response, makeNext())

    const body = res.body as { error: string }
    expect(body.error).not.toContain("Internal secret details")
    expect(body.error).toBe("Internal server error")

    env.NODE_ENV = savedEnv
  })

  it("exposes error message in development", () => {
    const savedEnv = env.NODE_ENV
    env.NODE_ENV = "development"

    const err = new Error("Detailed dev message")
    const req = makeReq()
    const res = makeRes()

    errorMiddleware(err, req as Request, res as unknown as Response, makeNext())

    const body = res.body as { error: string }
    expect(body.error).toContain("Detailed dev message")

    env.NODE_ENV = savedEnv
  })
})

// ── F7: body-parser errors ─────────────────────────────────────────────────
// Until F7 was fixed these fell through to the generic 500 branch.
describe("errorMiddleware() — body-parser errors (F7)", () => {
  /** The shape body-parser + http-errors emit: Error with `type` + `status`. */
  function makeBodyParserError(type: string, status: number): Error {
    const err = new Error(`[${type}] body rejected`)
    Object.assign(err, { type, status, statusCode: status })
    return err
  }

  it("maps entity.too.large to 413 with the size message", () => {
    const res = makeRes()

    errorMiddleware(
      makeBodyParserError("entity.too.large", 413),
      makeReq() as Request,
      res as unknown as Response,
      makeNext()
    )

    expect(res.statusCode).toBe(413)
    const body = res.body as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain("2 MB")
  })

  it("maps entity.parse.failed to 400 with an invalid-JSON message", () => {
    const res = makeRes()

    errorMiddleware(
      makeBodyParserError("entity.parse.failed", 400),
      makeReq() as Request,
      res as unknown as Response,
      makeNext()
    )

    expect(res.statusCode).toBe(400)
    const body = res.body as { error: string }
    expect(body.error).toContain("Invalid JSON")
  })

  it("uses the parser's own status for other body errors (e.g. 415 charset)", () => {
    const res = makeRes()

    errorMiddleware(
      makeBodyParserError("entity.supported-charset", 415),
      makeReq() as Request,
      res as unknown as Response,
      makeNext()
    )

    expect(res.statusCode).toBe(415)
    const body = res.body as { error: string }
    expect(body.error).toBe("Invalid request body")
  })

  it("does not mistake a plain Error for a body-parser error", () => {
    const res = makeRes()

    errorMiddleware(new Error("boom"), makeReq() as Request, res as unknown as Response, makeNext())

    expect(res.statusCode).toBe(500)
  })
})

// ── F7 regression against REAL express.json() ──────────────────────────────
// Unit tests above hand-craft the error shape; these prove Express 5
// actually produces it and that the middleware answers 413/400 end to end.
describe("errorMiddleware() — real express.json() (F7 regression)", () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    const app = express()
    // Same constant as app.ts — the parser limit and the F7 message both
    // derive from config/limits.ts (Day 0.5).
    app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }))
    app.use((_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
    app.use(errorMiddleware)
    server = createServer(app)
    await new Promise<void>(resolve => {
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
  })

  it("returns 413 for a JSON body over the 2 MB limit", async () => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(3_000_000) }),
    })

    expect(response.status).toBe(413)
    const body = (await response.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain("2 MB")
  })

  it("returns 400 for a malformed JSON body", async () => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"broken":',
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain("Invalid JSON")
  })
})
