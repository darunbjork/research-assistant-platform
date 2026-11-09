// backend/src/utils/prisma.ts
// One PrismaClient for the whole process.
//
// WHY: every `new PrismaClient()` opens its own connection pool. The app used
// to create 9 of them (9 pools × connection_limit), which exhausted Postgres
// connections under load. Import this instance everywhere in src/ instead.

import { PrismaClient } from "@prisma/client"
import { logger, logError } from "./logger"

// `log: [{ emit: "event" }]` is what makes $on("warn")/$on("error") available.
export const prisma = new PrismaClient({
  log: [
    { emit: "event", level: "warn" },
    { emit: "event", level: "error" },
  ],
})

// Surface engine-level warnings/errors through the existing logger instead of
// letting them disappear or crash the process.
prisma.$on("warn", event => {
  logger.warn(event.message, { target: String(event.target ?? "") })
})

prisma.$on("error", event => {
  logError("Prisma error", new Error(event.message), {
    service: "prisma",
    target: String(event.target ?? ""),
  })
})

export default prisma
