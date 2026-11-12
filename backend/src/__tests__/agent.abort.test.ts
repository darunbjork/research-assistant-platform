// backend/src/__tests__/agent.abort.test.ts
// Task 2.9: AbortSignal cancellation and timeouts on Gemini calls.
//
// 1. A caller abort mid-run stops the ReAct loop — no further fetches.
// 2. withTimeout rejects a hanging fetch after a short real timeout
//    (AbortSignal.timeout uses internal timers that fake timers cannot tick).

import { AgentService } from "../services/agent.service"
import { withTimeout, isAbortError, GEMINI_TIMEOUT_MS } from "../utils/abort"
import type { HybridSearchService } from "../services/hybrid.search.service"
import type { GenerationService } from "../services/generation.service"

// ── Response helpers (shapes copied from agent.service.test.ts) ────────────

function makeRagSearchDecisionResponse(): Response {
  const body = {
    candidates: [
      {
        content: {
          parts: [
            {
              text: '{"toolName":"rag_search","input":{"query":"machine learning"},"reason":"Need info."}',
            },
          ],
          role: "model",
        },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 30, totalTokenCount: 180 },
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function makeDoneDecisionResponse(): Response {
  const body = {
    candidates: [
      {
        content: {
          parts: [{ text: '{"toolName":"DONE","input":{},"reason":"I have enough information."}' }],
          role: "model",
        },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function makeSynthesisResponse(text = "The answer."): Response {
  const body = {
    candidates: [
      {
        content: {
          parts: [{ text }],
          role: "model",
        },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 50, totalTokenCount: 350 },
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError")
}

/** A fetch stand-in that never settles unless its signal aborts. */
function hangingFetch(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true })
  })
}

// ── Mocks ──────────────────────────────────────────────────────────────────

function makeMockHybridSearch(): jest.Mocked<HybridSearchService> {
  return {
    search: jest.fn().mockResolvedValue([]),
    compareStrategies: jest.fn().mockResolvedValue({}),
    toCitations: jest.fn().mockReturnValue([]),
  } as unknown as jest.Mocked<HybridSearchService>
}

function makeMockGenerationService(): jest.Mocked<GenerationService> {
  return {
    generate: jest.fn(),
    generateWithFallback: jest.fn().mockResolvedValue({
      answer: "I don't have enough information.",
      citations: [],
      tokensUsed: 0,
      model: "gemini-3.6-flash",
      durationMs: 5,
    }),
    estimatePromptTokens: jest.fn().mockReturnValue(500),
  } as unknown as jest.Mocked<GenerationService>
}

// ── withTimeout ────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("rejects a hanging fetch after a short real timeout", async () => {
    const signal = withTimeout(undefined, 25)

    await expect(hangingFetch(signal)).rejects.toMatchObject({ name: "AbortError" })
  })

  it("rejects as soon as the caller aborts, even with a far-away timeout", async () => {
    const controller = new AbortController()
    const signal = withTimeout(controller.signal, GEMINI_TIMEOUT_MS)

    const pending = hangingFetch(signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("isAbortError only matches AbortError, not timeouts or plain errors", () => {
    expect(isAbortError(abortError())).toBe(true)
    expect(isAbortError(new DOMException("too slow", "TimeoutError"))).toBe(false)
    expect(isAbortError(new Error("boom"))).toBe(false)
    expect(isAbortError("not an error")).toBe(false)
  })
})

// ── AgentService.run() cancellation ────────────────────────────────────────

describe("AgentService.run() cancellation", () => {
  let service: AgentService
  let mockHybridSearch: jest.Mocked<HybridSearchService>
  let mockGeneration: jest.Mocked<GenerationService>
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    mockHybridSearch = makeMockHybridSearch()
    mockGeneration = makeMockGenerationService()
    service = new AgentService("fake-api-key", mockHybridSearch, mockGeneration)
    fetchSpy = jest.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("stops fetching after an abort during iteration 1 and returns status 'aborted'", async () => {
    const controller = new AbortController()

    // The rag_search tool aborts the run mid-iteration.
    mockHybridSearch.search.mockImplementation(async () => {
      controller.abort()
      return []
    })

    fetchSpy
      // Iteration 1 reasoning → rag_search
      .mockResolvedValueOnce(makeRagSearchDecisionResponse())
      // Draft answer: real fetch rejects immediately when the signal is aborted.
      .mockImplementationOnce((_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (init?.signal?.aborted) {
          return Promise.reject(abortError())
        }
        return Promise.resolve(makeSynthesisResponse("unreachable"))
      })

    const result = await service.run("what is machine learning?", "user-1", controller.signal)

    expect(result.status).toBe("aborted")
    // reasoning (1) + aborted draft attempt (2) — no evaluation, no synthesis.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("stops at the loop-top check when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await service.run("what is machine learning?", "user-1", controller.signal)

    expect(result.status).toBe("aborted")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("treats a reasoning abort as 'aborted', not as an error", async () => {
    const controller = new AbortController()

    fetchSpy.mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(abortError())
    })

    const result = await service.run("what is machine learning?", "user-1", controller.signal)

    expect(result.status).toBe("aborted")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("runs to completion when the signal is never aborted", async () => {
    const controller = new AbortController()

    // DONE on the first iteration → synthesise falls back to
    // generateWithFallback (no tool history), so exactly one fetch.
    fetchSpy.mockResolvedValueOnce(makeDoneDecisionResponse())

    const result = await service.run("what is machine learning?", "user-1", controller.signal)

    expect(result.status).toBe("done")
    expect(result.finalAnswer).toBe("I don't have enough information.")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
