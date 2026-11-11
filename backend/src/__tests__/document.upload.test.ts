// backend/src/__tests__/document.upload.test.ts
//
// Task 4.1 (D17): POST /api/v1/documents/upload (multipart/form-data).
// Runs the real document routes + real multer + real error middleware against
// a listening server; Redis, auth and the Bull queue are mocked. Fixtures are
// generated at runtime with pdf-lib. Gemini is never involved.

import { PDFDocument, StandardFonts } from "pdf-lib"

// ── Mock Redis (rate limiter INCR/EXPIRE NX/TTL + budget INCRBY chains) ──
const mockRedisStore = new Map<string, number>()
const mockTtlStore = new Map<string, number>()

const mockRedis = {
  multi: jest.fn(() => {
    let incCount = 0
    let expireResult = 0
    let ttlResult = -1
    const pipeline: {
      incr: jest.Mock
      incrby: jest.Mock
      expire: jest.Mock
      ttl: jest.Mock
      exec: jest.Mock
    } = {
      incr: jest.fn((key: string): typeof pipeline => {
        const next = (mockRedisStore.get(key) ?? 0) + 1
        mockRedisStore.set(key, next)
        incCount = next
        return pipeline
      }),
      incrby: jest.fn((key: string, by: number): typeof pipeline => {
        const next = (mockRedisStore.get(key) ?? 0) + by
        mockRedisStore.set(key, next)
        incCount = next
        return pipeline
      }),
      expire: jest.fn((key: string, seconds: number, nx?: string): typeof pipeline => {
        if (nx === "NX" && mockTtlStore.has(key)) {
          expireResult = 0
        } else {
          mockTtlStore.set(key, seconds)
          expireResult = 1
        }
        return pipeline
      }),
      ttl: jest.fn((key: string): typeof pipeline => {
        ttlResult = mockTtlStore.get(key) ?? -1
        return pipeline
      }),
      exec: jest.fn(
        async (): Promise<Array<[null, number]>> => [
          [null, incCount],
          [null, expireResult],
          [null, ttlResult],
        ]
      ),
    }
    return pipeline
  }),
}

jest.mock("../utils/redis", () => ({ redis: mockRedis, default: mockRedis }))

// env is parsed once at import (task 3.1) — mock it with a mutable copy.
jest.mock("../config/env", () => {
  const actual = jest.requireActual("../config/env") as typeof import("../config/env")
  return { ...actual, env: { ...actual.env } }
})

// Auth: inject a user, JWT verification is out of scope here.
jest.mock("../middleware/auth.middleware", () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void): void => {
    req.user = { userId: "user-upload", role: "USER" }
    next()
  },
}))

// Queue: capture what would be handed to Bull.
const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-123" })
jest.mock("../queue/index", () => ({
  getIngestionQueue: jest.fn(() => ({ add: mockQueueAdd })),
  getJobStatus: jest.fn(),
}))

// ── Modules under test (required AFTER the mocks are defined) ─────────────
const documentRoutes = (
  require("../routes/document.routes") as {
    default: import("express").Router
  }
).default
const { errorMiddleware } =
  require("../middleware/error.middleware") as typeof import("../middleware/error.middleware")

// ── Helpers ───────────────────────────────────────────────────────────────

async function makePdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  let y = 720
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font })
    y -= 16
  }
  return Buffer.from(await doc.save())
}

function toBlobPart(data: string | Uint8Array): BlobPart {
  if (typeof data === "string") {
    return data
  }
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}

function uploadFile(
  baseUrl: string,
  name: string,
  type: string,
  data: Uint8Array | string
): Promise<Response> {
  const form = new FormData()
  form.append("file", new Blob([toBlobPart(data)], { type }), name)
  return fetch(`${baseUrl}/api/v1/documents/upload`, { method: "POST", body: form })
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/v1/documents/upload (multipart)", () => {
  let server: import("http").Server
  let baseUrl: string

  beforeAll(async () => {
    const express = require("express") as typeof import("express")
    const app = express()
    app.use(express.json())
    app.use("/api/v1/documents", documentRoutes)
    app.use(errorMiddleware)

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
    mockRedisStore.clear()
    mockTtlStore.clear()
    jest.clearAllMocks()
  })

  it("accepts a real PDF, extracts its text and queues it (202)", async () => {
    const pdf = await makePdf([
      "Quarterly research summary for the deploy readiness review.",
      "The retrieval pipeline achieves strong recall on the eval set.",
      "Embeddings are produced by a Gemini model and stored in pgvector.",
    ])

    const res = await uploadFile(baseUrl, "report.pdf", "application/pdf", pdf)
    expect(res.status).toBe(202)

    const body = (await res.json()) as {
      success: boolean
      data: { jobId: string; status: string; name: string } | null
      error: string | null
    }
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ jobId: "job-123", status: "queued", name: "report.pdf" })

    expect(mockQueueAdd).toHaveBeenCalledTimes(1)
    const queueCalls = (mockQueueAdd.mock as { calls: unknown[][] }).calls
    const payload = (queueCalls[0]?.[0] ?? {}) as Record<string, unknown>
    expect(payload).toMatchObject({
      name: "report.pdf",
      mimeType: "application/pdf",
      userId: "user-upload",
    })
    expect(String(payload.content)).toContain("Quarterly research summary")
    expect(String(payload.content).length).toBeGreaterThanOrEqual(50)
  })

  it("accepts a .txt file and passes the text through", async () => {
    const res = await uploadFile(baseUrl, "notes.txt", "text/plain", "plain research notes")

    expect(res.status).toBe(202)
    expect(mockQueueAdd).toHaveBeenCalledTimes(1)
    const queueCalls = (mockQueueAdd.mock as { calls: unknown[][] }).calls
    const payload = (queueCalls[0]?.[0] ?? {}) as Record<string, unknown>
    expect(payload.content).toBe("plain research notes")
    expect(payload.name).toBe("notes.txt")
  })

  it("rejects a fake PDF with the wrong magic bytes (400)", async () => {
    const res = await uploadFile(
      baseUrl,
      "fake.pdf",
      "application/pdf",
      "NOT-A-REAL-PDF-FILE-AT-ALL-XXXXXXXX"
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain("not a valid PDF")
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })

  it("rejects an .exe (400)", async () => {
    const res = await uploadFile(
      baseUrl,
      "setup.exe",
      "application/octet-stream",
      "MZ\x90\x00 binary"
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.error).toContain("Unsupported file type")
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })

  it("rejects a request with no file field (400)", async () => {
    const empty = new FormData()
    const res = await fetch(`${baseUrl}/api/v1/documents/upload`, { method: "POST", body: empty })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Missing file")
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })

  it("rejects a multipart body that uses the wrong field name (400)", async () => {
    const form = new FormData()
    form.append("other", new Blob(["x"], { type: "text/plain" }), "x.txt")
    const res = await fetch(`${baseUrl}/api/v1/documents/upload`, { method: "POST", body: form })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Unexpected field")
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })

  it("rejects a file over 10 MB with 413", async () => {
    const elevenMb = new Uint8Array(11 * 1024 * 1024)
    const res = await uploadFile(baseUrl, "big.pdf", "application/pdf", elevenMb)

    expect(res.status).toBe(413)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain("10 MB")
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })
})
