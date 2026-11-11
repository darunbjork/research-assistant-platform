// backend/src/__tests__/document.jobstatus.test.ts
//
// D7 (job-status IDOR): a job that belongs to another user must produce the
// exact same 404 as a job that doesn't exist — never a 200 with data and
// never a 403 (404 is the project's convention for "not found / not yours").
//
// The real getJobStatus() from queue/index is used; only getIngestionQueue()
// is mocked so no Bull/Redis connection is opened.

jest.mock("../queue/index", () => {
  const actual = jest.requireActual<typeof import("../queue/index")>("../queue/index")
  return { ...actual, getIngestionQueue: jest.fn() }
})

// DocumentController imports searchCache for delete(); keep the module load
// hermetic (no real Redis connection in unit tests).
jest.mock("../cache/index", () => ({
  searchCache: { clearForUser: jest.fn() },
}))

// queue/index → ingestion.queue → global-budget → utils/redis; keep the
// module load hermetic (no real Redis connection in unit tests).
jest.mock("../utils/redis", () => ({
  redis: {},
  default: {},
}))

import type { Request, Response, NextFunction } from "express"
import type Bull from "bull"
import { getIngestionQueue } from "../queue/index"
import type { IngestionJobData } from "../queue/index"
import { DocumentController } from "../controllers/document.controller"

const OWNER = "user-owner"
const ATTACKER = "user-attacker"
const JOB_ID = "job-42"

function makeJob(overrides: Partial<IngestionJobData> = {}) {
  return {
    id: JOB_ID,
    data: {
      name: "doc.txt",
      content: "hello",
      mimeType: "text/plain",
      sizeBytes: 5,
      userId: OWNER,
      requestId: "req-1",
      ...overrides,
    },
    getState: jest.fn().mockResolvedValue("completed"),
    progress: jest.fn().mockReturnValue(100),
    failedReason: undefined,
    timestamp: 1_700_000_000_000,
    finishedOn: 1_700_000_001_000,
    returnvalue: {
      documentId: "doc-1",
      name: "doc.txt",
      chunkCount: 1,
      tokenCount: 2,
      durationMs: 5,
    },
  }
}

function makeQueue(job: ReturnType<typeof makeJob> | null) {
  return {
    getJob: jest.fn().mockResolvedValue(job),
  } as unknown as Bull.Queue<IngestionJobData>
}

function makeRequest(userId: string | undefined, jobId: string = JOB_ID): Request {
  return {
    user: userId === undefined ? undefined : { userId, role: "USER" },
    params: { jobId },
  } as unknown as Request
}

function makeResponse(): Response & {
  status: jest.Mock
  json: jest.Mock
} {
  const res = {} as Response & { status: jest.Mock; json: jest.Mock }
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("GET /documents/jobs/:jobId — ownership (D7)", () => {
  let controller: DocumentController
  let next: jest.MockedFunction<NextFunction>

  beforeEach(() => {
    controller = new DocumentController()
    next = jest.fn()
    ;(getIngestionQueue as jest.Mock).mockReset()
  })

  it("returns 200 with the status when the owner asks", async () => {
    ;(getIngestionQueue as jest.Mock).mockReturnValue(makeQueue(makeJob()))

    const res = makeResponse()
    await controller.getJobStatus(makeRequest(OWNER), res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ jobId: JOB_ID, status: "completed" }) as Record<
          string,
          unknown
        >,
      })
    )
    expect(next).not.toHaveBeenCalled()
  })

  it("returns 404 for another user's job — identical to a missing job", async () => {
    ;(getIngestionQueue as jest.Mock).mockReturnValue(makeQueue(makeJob()))

    const attackerRes = makeResponse()
    await controller.getJobStatus(makeRequest(ATTACKER), attackerRes, next)

    // Missing job → 404
    ;(getIngestionQueue as jest.Mock).mockReturnValue(makeQueue(null))
    const missingRes = makeResponse()
    await controller.getJobStatus(makeRequest(OWNER, "job-does-not-exist"), missingRes, next)

    expect(attackerRes.status).toHaveBeenCalledWith(404)
    expect(missingRes.status).toHaveBeenCalledWith(404)

    // Same body shape: only the jobId in the message differs.
    const attackerBody = (attackerRes.json.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    const missingBody = (missingRes.json.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(attackerBody.success).toBe(missingBody.success)
    expect(attackerBody.data).toBe(missingBody.data)
    expect(typeof attackerBody.error).toBe("string")
    expect(attackerBody.error).toContain(JOB_ID)
  })

  it("does not leak job data to another user", async () => {
    ;(getIngestionQueue as jest.Mock).mockReturnValue(makeQueue(makeJob()))

    const res = makeResponse()
    await controller.getJobStatus(makeRequest(ATTACKER), res, next)

    const body = JSON.stringify((res.json.mock.calls[0] as unknown[])[0])
    expect(body).not.toContain("completed")
    expect(body).not.toContain("doc.txt")
  })

  it("returns 401 when not authenticated", async () => {
    const res = makeResponse()
    await controller.getJobStatus(makeRequest(undefined), res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})
