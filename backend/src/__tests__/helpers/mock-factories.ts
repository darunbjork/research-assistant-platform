// backend/src/__tests__/helpers/mock-factories.ts
// Centralised mock factories for all services.
// Import from here instead of duplicating in every test file.
//
// FACTORY PATTERN:
// Each factory returns a fresh mock object.
// Creating fresh mocks prevents state leakage between tests.
// Tests that share a mock object can interfere with each other.
//
// USAGE:
//   import { makeMockEmbeddingService, makeGeminiResponse } from "./helpers/mock-factories"
//   const embedding = makeMockEmbeddingService()
//   fetchSpy.mockResolvedValueOnce(makeGeminiResponse("answer text"))

import type { HybridSearchService } from "../../services/hybrid.search.service"
import type { EmbeddingService } from "../../services/embedding.service"
import type { GenerationService } from "../../services/generation.service"
import type { HybridSearchResult } from "../../types/retrieval.types"
import type { PrismaClient } from "@prisma/client"

// ── Gemini API Response Factories ─────────────────────────────────────────

// Creates a realistic Gemini generateContent response
export function makeGeminiResponse(
  text: string = "Default generated response.",
  totalTokens: number = 150,
  finishReason: "STOP" | "MAX_TOKENS" = "STOP"
): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text }],
            role: "model",
          },
          finishReason,
          safetyRatings: [],
        },
      ],
      usageMetadata: {
        promptTokenCount: totalTokens - 50,
        candidatesTokenCount: 50,
        totalTokenCount: totalTokens,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )
}

// Creates a Gemini embedding response with N vectors of 768 dimensions
export function makeGeminiEmbeddingResponse(count: number = 1, fillValue: number = 0.1): Response {
  const embeddings = Array.from({ length: count }, () => ({
    values: Array(768).fill(fillValue) as number[],
  }))

  return new Response(JSON.stringify({ embeddings }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// Creates a Gemini error response
export function makeGeminiErrorResponse(
  status: number = 429,
  message: string = "Resource exhausted"
): Response {
  return new Response(JSON.stringify({ error: { message, code: status } }), {
    status,
    statusText: status === 429 ? "Too Many Requests" : "Error",
  })
}

// Creates a JSON decision response (for ReAct reasoning)
export function makeToolDecisionResponse(
  toolName: string,
  input: Record<string, string> = {},
  reason: string = "test reason"
): Response {
  return makeGeminiResponse(JSON.stringify({ toolName, input, reason }))
}

// Creates a scoring response for the evaluator
export function makeEvalScoreResponse(
  score: number = 0.8,
  explanation: string = "Test explanation"
): Response {
  return makeGeminiResponse(JSON.stringify({ score, explanation }))
}

// ── Service Mock Factories ─────────────────────────────────────────────────

// Returns a mock EmbeddingService
export function makeMockEmbeddingService(): jest.Mocked<EmbeddingService> {
  return {
    embedText: jest.fn().mockResolvedValue(Array(768).fill(0.1) as number[]),
    embedBatch: jest
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => Array(768).fill(0.1) as number[]))
      ),
    getCacheStats: jest.fn().mockReturnValue({
      hits: 0,
      misses: 0,
      hitRate: 0,
    }),
  } as unknown as jest.Mocked<EmbeddingService>
}

// Returns a mock GenerationService
export function makeMockGenerationService(): jest.Mocked<GenerationService> {
  return {
    generate: jest.fn().mockResolvedValue({
      answer: "Mocked generated answer [Source 1].",
      citations: [],
      tokensUsed: 150,
      model: "gemini-2.0-flash",
      durationMs: 500,
    }),
    generateWithFallback: jest.fn().mockResolvedValue({
      answer: "I don't have enough information in the provided documents.",
      citations: [],
      tokensUsed: 0,
      model: "gemini-2.0-flash",
      durationMs: 5,
    }),
    estimatePromptTokens: jest.fn().mockReturnValue(500),
  } as unknown as jest.Mocked<GenerationService>
}

// Returns a mock HybridSearchService
export function makeMockHybridSearchService(
  results: HybridSearchResult[] = []
): jest.Mocked<HybridSearchService> {
  return {
    search: jest.fn().mockResolvedValue(results),
    searchAndRerank: jest.fn().mockResolvedValue([]),
    compareStrategies: jest.fn().mockResolvedValue({}),
    toCitations: jest.fn().mockReturnValue([]),
  } as unknown as jest.Mocked<HybridSearchService>
}

// ── Data Fixtures ──────────────────────────────────────────────────────────

// Creates a realistic HybridSearchResult
export function makeHybridSearchResult(
  overrides: Partial<{
    id: string
    content: string
    source: string
    rrfScore: number
    vectorRank: number
    keywordRank: number
    pageNumber: number | null
  }> = {}
): HybridSearchResult {
  return {
    chunk: {
      id: overrides.id ?? "chunk-test-001",
      documentId: "doc-test-001",
      content: overrides.content ?? "Machine learning is a subset of AI.",
      chunkIndex: 0,
      tokenCount: 10,
      source: overrides.source ?? "test-document.txt",
      pageNumber: overrides.pageNumber ?? null,
      chunkingStrategy: "recursive",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    vectorRank: overrides.vectorRank ?? 0,
    keywordRank: overrides.keywordRank ?? 0,
    rrfScore: overrides.rrfScore ?? 0.032,
  }
}

// Creates a realistic PrismaClient mock
export function makeMockPrismaClient(): jest.Mocked<PrismaClient> {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn().mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops)),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    document: {
      create: jest.fn().mockResolvedValue({
        id: "doc-mock-001",
        name: "test.txt",
        content: "test content",
        mimeType: "text/plain",
        sizeBytes: 100,
        userId: "user-mock-001",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    documentChunk: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      create: jest.fn().mockResolvedValue({
        id: "user-mock-001",
        email: "test@example.com",
        passwordHash: "$2b$12$hash",
        role: "USER",
        createdAt: new Date(),
      }),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    agentSession: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  } as unknown as jest.Mocked<PrismaClient>
}

// Creates a mock Redis client
export function makeMockRedisClient() {
  const store = new Map<string, string>()

  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, val: string) => {
      store.set(key, val)
      return "OK"
    }),
    setex: jest.fn(async (key: string, _ttl: number, val: string) => {
      store.set(key, val)
      return "OK"
    }),
    del: jest.fn(async (...keys: string[]) => {
      let count = 0
      keys.forEach(k => {
        if (store.delete(k)) count++
      })
      return count
    }),
    incr: jest.fn(async (key: string) => {
      const current = parseInt(store.get(key) ?? "0", 10)
      const next = current + 1
      store.set(key, String(next))
      return next
    }),
    expire: jest.fn(async () => 1),
    ttl: jest.fn(async () => 3600),
    ping: jest.fn(async () => "PONG"),
    quit: jest.fn(async () => "OK"),
    scan: jest.fn(async () => ["0", []]),
    on: jest.fn(),
    store, // expose for test assertions
    clear: () => store.clear(),
  }
}

// ── Request/Response Builders ─────────────────────────────────────────────

// Creates a typed Express request mock
export function makeExpressRequest(
  overrides: {
    userId?: string
    role?: "USER" | "ADMIN" | "GUEST"
    body?: Record<string, unknown>
    params?: Record<string, string>
    query?: Record<string, string>
  } = {}
): Record<string, unknown> {
  return {
    user: overrides.userId
      ? {
          userId: overrides.userId,
          email: "test@example.com",
          role: overrides.role ?? "USER",
        }
      : undefined,
    body: overrides.body ?? {},
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    headers: {},
  }
}

// Creates a typed Express response mock
export function makeExpressResponse() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, unknown>,

    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
    send(body?: unknown) {
      this.body = body
      return this
    },
    setHeader(name: string, value: unknown) {
      this.headers[name] = value
      return this
    },
  }
  return res
}
