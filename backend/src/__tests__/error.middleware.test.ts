// backend/src/__tests__/error.middleware.test.ts
// Tests for the global error middleware and custom error classes.

import type { Request, Response, NextFunction } from "express"
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
    const savedEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "production"

    const err = new Error("Internal secret details")
    const req = makeReq()
    const res = makeRes()

    errorMiddleware(err, req as Request, res as unknown as Response, makeNext())

    const body = res.body as { error: string }
    expect(body.error).not.toContain("Internal secret details")
    expect(body.error).toBe("Internal server error")

    process.env.NODE_ENV = savedEnv
  })

  it("exposes error message in development", () => {
    const savedEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "development"

    const err = new Error("Detailed dev message")
    const req = makeReq()
    const res = makeRes()

    errorMiddleware(err, req as Request, res as unknown as Response, makeNext())

    const body = res.body as { error: string }
    expect(body.error).toContain("Detailed dev message")

    process.env.NODE_ENV = savedEnv
  })
})
