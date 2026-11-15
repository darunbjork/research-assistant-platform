import type { HybridSearchResult } from "../../types/retrieval.types"
import type { AgentResult } from "../../types/agent.types"
import type { ServerMessage } from "../../types/websocket.types"
import { RateLimitError } from "../../middleware/error.middleware"

export type FetchKind =
  | "generateContent:reason"
  | "generateContent:draft"
  | "generateContent:evaluate"
  | "generateContent:synthesis"
  | "generateContent:unknown"
  | "batchEmbedContents"

export type ScriptedResponse =
  | { kind: "json"; body: unknown; status?: number; headers?: Record<string, string> }
  | { kind: "httpError"; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: "throw"; error: Error }

export interface ScriptRecord {
  kind: FetchKind
  url: string
  bodyText: string
}

export interface GeminiScriptHandle {
  records: ScriptRecord[]
  restore: () => void
}

function classifyFetch(url: string, init?: RequestInit): FetchKind {
  if (url.includes(":batchEmbedContents")) return "batchEmbedContents"
  if (!url.includes(":generateContent")) return "generateContent:unknown"
  let text = ""
  try {
    const body = init?.body
    if (typeof body === "string") {
      const parsed = JSON.parse(body) as { contents?: Array<{ parts?: Array<{ text?: string }> }> }
      text = parsed.contents?.map(c => c.parts?.map(p => p.text ?? "").join("")).join("\n") ?? ""
    }
  } catch {
    text = ""
  }
  const t = text.toLowerCase()
  if (text.includes("quality evaluator for an AI research assistant"))
    return "generateContent:evaluate"
  if (text.includes("deciding the next action")) return "generateContent:reason"
  if (t.includes("draft a concise answer") || t.includes("draft answer (2-4 sentences)")) {
    return "generateContent:draft"
  }
  if (text.includes("Answer using ONLY the evidence")) return "generateContent:synthesis"
  // HTTP agent has slightly different wording in some prompts pre-refactor
  if (text.includes("synthesise") || t.includes("precise research assistant. answer using only")) {
    return "generateContent:synthesis"
  }
  return "generateContent:unknown"
}

export function scriptGemini(responses: ScriptedResponse[]): GeminiScriptHandle {
  let index = 0
  const records: ScriptRecord[] = []
  const spy = jest
    .spyOn(global, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const bodyText = typeof init?.body === "string" ? init.body : ""
      const kind = classifyFetch(url, init)
      records.push({ kind, url, bodyText })

      const scripted = responses[index++]
      if (!scripted) {
        throw new Error(`Unexpected Gemini/fetch call #${index} (${kind}) to ${url}`)
      }

      if (scripted.kind === "throw") {
        throw scripted.error
      }

      if (scripted.kind === "httpError") {
        const headers = new Headers({
          "Content-Type": "application/json",
          ...(scripted.headers ?? {}),
        })
        return new Response(
          JSON.stringify(scripted.body ?? { error: { message: "error", code: scripted.status } }),
          {
            status: scripted.status,
            statusText: scripted.status === 429 ? "Too Many Requests" : "Error",
            headers,
          }
        )
      }

      const status = scripted.status ?? 200
      const headers = new Headers({
        "Content-Type": "application/json",
        ...(scripted.headers ?? {}),
      })
      return new Response(JSON.stringify(scripted.body), { status, headers })
    })

  return {
    records,
    restore: () => {
      spy.mockRestore()
    },
  }
}

export function makeGeminiJson(text: string, totalTokens = 100): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text }], role: "model" },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: {
      promptTokenCount: Math.max(0, totalTokens - 20),
      candidatesTokenCount: 20,
      totalTokenCount: totalTokens,
    },
  }
}

export function decision(
  toolName: string,
  input: Record<string, string> = {},
  reason = "test"
): ScriptedResponse {
  return { kind: "json", body: makeGeminiJson(JSON.stringify({ toolName, input, reason })) }
}

export function textResponse(text: string, totalTokens = 100): ScriptedResponse {
  return { kind: "json", body: makeGeminiJson(text, totalTokens) }
}

export function evalResponse(
  score: number,
  opts: { shouldRetry?: boolean; retryReason?: string; suggestedQuery?: string } = {}
): ScriptedResponse {
  const shouldRetry = opts.shouldRetry ?? score < 0.7
  return {
    kind: "json",
    body: makeGeminiJson(
      JSON.stringify({
        contextRelevance: score,
        faithfulness: score,
        answerRelevance: score,
        shouldRetry,
        retryReason: opts.retryReason ?? (shouldRetry ? "Low quality" : ""),
        suggestedQuery: opts.suggestedQuery,
      }),
      50
    ),
  }
}

export function http429(retryAfterSeconds = 0): ScriptedResponse {
  return {
    kind: "httpError",
    status: 429,
    headers: { "Retry-After": String(retryAfterSeconds) },
    body: { error: { message: "Resource exhausted", code: 429 } },
  }
}

export function makeHybridResult(
  overrides: Partial<{
    content: string
    source: string
    rrfScore: number
    pageNumber: number | null
    id: string
  }> = {}
): HybridSearchResult {
  return {
    chunk: {
      id: overrides.id ?? "chunk-1",
      documentId: "doc-1",
      content: overrides.content ?? "Relevant evidence content about the query.",
      chunkIndex: 0,
      tokenCount: 10,
      source: overrides.source ?? "doc.txt",
      pageNumber: overrides.pageNumber ?? null,
      chunkingStrategy: "recursive",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    vectorRank: 1,
    keywordRank: 1,
    rrfScore: overrides.rrfScore ?? 0.03,
  }
}

export interface StubSearchOptions {
  results?: HybridSearchResult[]
  error?: Error
  impl?: (query: string, options: unknown, signal?: AbortSignal) => Promise<HybridSearchResult[]>
}

export function makeStubHybridSearch(options: StubSearchOptions = {}): {
  search: jest.Mock
  calls: Array<{ query: string; options: unknown; signal?: AbortSignal }>
} {
  const calls: Array<{ query: string; options: unknown; signal?: AbortSignal }> = []
  const search = jest.fn(async (query: string, opts: unknown, signal?: AbortSignal) => {
    calls.push({ query, options: opts, signal })
    if (options.impl) return options.impl(query, opts, signal)
    if (options.error) throw options.error
    return options.results ?? [makeHybridResult()]
  })
  return { search, calls }
}

export function makeStubGenerationService(
  fallbackAnswer = "I don't have enough information in the provided documents."
): {
  generateWithFallback: jest.Mock
  generate: jest.Mock
  estimatePromptTokens: jest.Mock
} {
  return {
    generateWithFallback: jest.fn().mockResolvedValue({
      answer: fallbackAnswer,
      citations: [],
      tokensUsed: 0,
      model: "test",
      durationMs: 0,
    }),
    generate: jest.fn().mockResolvedValue({
      answer: fallbackAnswer,
      citations: [],
      tokensUsed: 0,
      model: "test",
      durationMs: 0,
    }),
    estimatePromptTokens: jest.fn().mockReturnValue(0),
  }
}

export function normalizeResult(result: AgentResult): unknown {
  return {
    ...result,
    sessionId: "<session>",
    durationMs: 0,
    citations: result.citations.map(c => ({
      ...c,
      // normalize per plan 1.1; V7 (agent-*/stream-* and agent-retrieved/stream-retrieved) noted in characterization report
      chunkId: "<chunk>",
      documentId: "<doc>",
    })),
    // V11 (discovered): HTTP records eval-step toolUsed as explicit undefined, WS omits it.
    // Canonicalize by dropping undefined keys so snapshots compare semantic content.
    steps: result.steps.map(s => {
      const step: Record<string, unknown> = {
        ...s,
        durationMs: 0,
        timestamp: "<ts>",
      }
      if (step["toolUsed"] === undefined) delete step["toolUsed"]
      return step
    }),
  }
}

export function normalizeEvents(events: ServerMessage[]): unknown[] {
  return events.map(e => {
    if (e.type === "status") return { type: e.type, status: e.status }
    if (e.type === "step") {
      return {
        type: e.type,
        step: {
          stepNumber: e.step.stepNumber,
          description: e.step.description,
          toolUsed: e.step.toolUsed,
        },
      }
    }
    if (e.type === "quality") {
      return {
        type: e.type,
        scoreBucket: e.score >= 0.7 ? "high" : "low",
        shouldRetry: e.shouldRetry,
        retryReason: e.retryReason ?? "",
        suggestedQuery: e.suggestedQuery,
      }
    }
    if (e.type === "complete") {
      return { type: e.type, status: e.result.status }
    }
    if (e.type === "error") return { type: e.type, code: e.code }
    return { type: (e as { type: string }).type }
  })
}

export function rateLimitError(message = "rate limited"): RateLimitError {
  return new RateLimitError(message)
}
