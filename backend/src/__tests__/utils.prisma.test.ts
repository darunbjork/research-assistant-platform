// backend/src/__tests__/utils.prisma.test.ts
//
// The app must use ONE shared PrismaClient (task 1.4) whose warn/error events
// are routed through the app logger. @prisma/client is mocked so no engine is
// started and no database connection is attempted.

jest.mock("@prisma/client", () => {
  class PrismaClient {
    $on = jest.fn()
  }
  return { PrismaClient }
})

jest.mock("../utils/logger", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
  logError: jest.fn(),
}))

import { PrismaClient } from "@prisma/client"
import { prisma } from "../utils/prisma"
import { logger, logError } from "../utils/logger"

type LogEvent = { message: string; target?: string }
type OnCall = [string, (event: LogEvent) => void]

// Captured at module load — jest's clearMocks (config) wipes call history
// before each test, so the registrations done at import time must be copied
// here, while the module is being evaluated.
const onCalls = (prisma.$on as jest.Mock).mock.calls.slice() as OnCall[]

function getHandler(event: "warn" | "error"): (event: LogEvent) => void {
  const call = onCalls.find(entry => entry[0] === event)
  if (call === undefined) {
    throw new Error(`prisma.$on("${event}") was never registered`)
  }
  return call[1]
}

describe("utils/prisma (shared client)", () => {
  it("exports a single shared PrismaClient instance", () => {
    expect(prisma).toBeInstanceOf(PrismaClient)
  })

  it("registers warn and error log handlers", () => {
    expect(onCalls.map(entry => entry[0])).toEqual(expect.arrayContaining(["warn", "error"]))
    expect(getHandler("warn")).toEqual(expect.any(Function))
    expect(getHandler("error")).toEqual(expect.any(Function))
  })

  it("forwards Prisma warn events to logger.warn", () => {
    getHandler("warn")({ message: "slow query", target: "QueryEngine" })

    expect(logger.warn).toHaveBeenCalledWith("slow query", { target: "QueryEngine" })
  })

  it("forwards Prisma error events to logError with service prisma", () => {
    getHandler("error")({ message: "connection terminated", target: "transport" })

    expect(logError).toHaveBeenCalledWith(
      "Prisma error",
      expect.objectContaining({ message: "connection terminated" }),
      { service: "prisma", target: "transport" }
    )
  })
})
