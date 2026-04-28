// TODO: Winston gives us structured, levelled, searchable logging.
//
// Log levels (lowest to highest severity):
// ! debug → info → warn → error
// Setting LOG_LEVEL="info" means debug logs are hidden in production.
//
// WHY STRUCTURED LOGGING?
// Unstructured: "Embedding complete after 380ms for 42 chunks"
//   → You cannot filter this. You cannot graph the duration.
// Structured:   { event: "embed", durationMs: 380, chunkCount: 42 }
//   → Log tools can filter by event="embed", graph durationMs over time.

import winston from "winston"
import DailyRotateFile from "winston-daily-rotate-file"

// ── Typed Log Metadata ────────────────────────────────────────────────────
// Every structured log entry in this project uses this shape.
// Adding a field? Add it here first. No sneaking in untyped keys.
export interface LogMeta {
  service?: string // which class/module logged this
  userId?: string // which user triggered this operation
  sessionId?: string // which agent session
  documentId?: string // which document was being processed
  durationMs?: number // how long the operation took
  tokenCount?: number // how many LLM tokens were consumed
  chunkCount?: number // how many chunks were produced/retrieved
  similarity?: number // cosine similarity score (0-1)
  toolName?: string // which agent tool was called
  iterationCount?: number // which ReAct loop iteration
  statusCode?: number // HTTP status code
  path?: string // request path
  method?: string // HTTP method
  [key: string]: string | number | boolean | undefined
}

// ── Log Formats ───────────────────────────────────────────────────────────
const { combine, timestamp, json, colorize, printf } = winston.format

// Development: human-readable with colors and timestamps
// Example: 14:32:01 [info] Embedding complete {"chunkCount":42,"durationMs":380}
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: "HH:mm:ss" }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    // Only show metadata if it exists — keeps simple logs clean
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ""
    return `${String(ts)} [${level}] ${String(message)}${metaStr}`
  })
)

// Production: pure JSON — ingested by Datadog, Grafana Loki, CloudWatch, etc.
// Example: {"level":"info","message":"Embedding complete","chunkCount":42,"timestamp":"..."}
const prodFormat = combine(timestamp(), json())

// ── Transports ────────────────────────────────────────────────────────────
// A transport is a destination for log output.
// We always log to console. In production, also write to rotating files.
const transports: winston.transport[] = [
  new winston.transports.Console({
    format: process.env.NODE_ENV === "production" ? prodFormat : devFormat,
  }),
]

// Production file logging — rotates daily, keeps 14 days of errors, 7 days combined
if (process.env.NODE_ENV === "production") {
  transports.push(
    // Error-only file — for alerting systems that watch for errors
    new DailyRotateFile({
      filename: "logs/error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      level: "error",
      maxFiles: "14d", // keep 14 days of error logs
      maxSize: "20m", // rotate if file exceeds 20MB
      format: prodFormat,
    }),
    // All logs combined
    new DailyRotateFile({
      filename: "logs/combined-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "7d",
      maxSize: "50m",
      format: prodFormat,
    })
  )
}

// ── Create the Logger ─────────────────────────────────────────────────────
export const logger = winston.createLogger({
  // LOG_LEVEL from .env controls verbosity.
  // "debug" in development, "info" in production.
  level: process.env.LOG_LEVEL ?? "info",
  transports,
})

// ── Typed Helper Functions ────────────────────────────────────────────────
// These are the ONLY functions you call in the rest of the codebase.
// Never call logger.info() directly — always use these typed wrappers.
// This enforces consistent metadata shape across every service.

// For RAG pipeline events — chunking, embedding, retrieval, generation, agent steps
export function logRagEvent(
  event: "chunk" | "embed" | "retrieve" | "generate" | "agent_step" | "ingest" | "rerank",
  message: string,
  meta: LogMeta
): void {
  logger.info(message, { event, ...meta })
}

// For HTTP requests — called by the request logging middleware
export function logRequest(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
  meta: LogMeta = {}
): void {
  logger.info(`${method} ${path} ${statusCode}`, {
    event: "http_request",
    method,
    path,
    statusCode,
    durationMs,
    ...meta,
  })
}

// For errors — always include the error object for stack traces
export function logError(message: string, error: unknown, meta: LogMeta = {}): void {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorStack = error instanceof Error ? error.stack : undefined

  logger.error(message, {
    event: "error",
    error: errorMessage,
    stack: errorStack,
    ...meta,
  })
}

// For application startup events
export function logStartup(message: string, meta: LogMeta = {}): void {
  logger.info(message, { event: "startup", ...meta })
}
