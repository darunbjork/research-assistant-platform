import { StreamingAgentService } from "../services/streaming.agent.service"
import type { HybridSearchService } from "../services/hybrid.search.service"
import type { GenerationService } from "../services/generation.service"
import type { ServerMessage } from "../types/websocket.types"

// ── Mock Factories ────────────────────────────────────────────────────────

function makeMockHybridSearch(): jest.Mocked<HybridSearchService> {
  return {
    search: jest.fn().mockResolvedValue([]),
    compareStrategies: jest.fn().mockResolvedValue({}),
    toCitations: jest.fn().mockReturnValue([]),
  } as unknown as jest.Mocked<HybridSearchService>
}

function makeMockGeneration(): jest.Mocked<GenerationService> {
  return {
    generate: jest.fn().mockResolvedValue({
      answer: "Generated answer.",
      citations: [],
      tokensUsed: 100,
      model: "gemini-2.0-flash",
      durationMs: 500,
    }),
    generateWithFallback: jest.fn().mockResolvedValue({
      answer: "No info available.",
      citations: [],
      tokensUsed: 0,
      model: "gemini-2.0-flash",
      durationMs: 5,
    }),
    estimatePromptTokens: jest.fn().mockReturnValue(500),
  } as unknown as jest.Mocked<GenerationService>
}

function makeDoneDecisionResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: '{"toolName":"DONE","input":{},"reason":"Done."}' }],
            role: "model",
          },
          finishReason: "STOP",
          safetyRatings: [],
        },
      ],
      usageMetadata: { totalTokenCount: 50, promptTokenCount: 40, candidatesTokenCount: 10 },
    }),
    { status: 200 }
  )
}

function makeSynthesisResponse(text = "Final answer."): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text }], role: "model" },
          finishReason: "STOP",
          safetyRatings: [],
        },
      ],
      usageMetadata: { totalTokenCount: 200, promptTokenCount: 150, candidatesTokenCount: 50 },
    }),
    { status: 200 }
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("StreamingAgentService", () => {
  let service: StreamingAgentService
  let mockHybrid: jest.Mocked<HybridSearchService>
  let mockGen: jest.Mocked<GenerationService>
  let fetchSpy: jest.SpyInstance
  let emittedEvents: ServerMessage[]
  const onEvent = (msg: ServerMessage): void => {
    emittedEvents.push(msg)
  }

  beforeEach(() => {
    mockHybrid = makeMockHybridSearch()
    mockGen = makeMockGeneration()
    service = new StreamingAgentService("fake-key", mockHybrid, mockGen)
    fetchSpy = jest.spyOn(global, "fetch")
    emittedEvents = []
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  // ── Constructor ────────────────────────────────────────────────────────
  it("throws if API key is empty", () => {
    expect(() => new StreamingAgentService("", mockHybrid, mockGen)).toThrow(
      "StreamingAgentService requires a Gemini API key"
    )
  })

  // ── Event emission order ───────────────────────────────────────────────
  describe("event emission", () => {
    it("emits 'status: thinking' as the first event", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      await service.run("What is ML?", "user-1", "session-1", onEvent)

      expect(emittedEvents[0]?.type).toBe("status")
      if (emittedEvents[0]?.type === "status") {
        expect(emittedEvents[0].status).toBe("thinking")
      }
    })

    it("emits 'complete' as the last event", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      await service.run("What is ML?", "user-1", "session-1", onEvent)

      const last = emittedEvents[emittedEvents.length - 1]
      expect(last?.type).toBe("complete")
    })

    it("emits at least one 'step' event when DONE is reached", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      await service.run("What is ML?", "user-1", "session-1", onEvent)

      const stepEvents = emittedEvents.filter(e => e.type === "step")
      expect(stepEvents.length).toBeGreaterThan(0)
    })

    it("emits 'complete' with the final result", async () => {
      // Step 1: reasoning → rag_search
      // Step 2: draft answer
      // Step 3: quality evaluation (score high enough to not retry)
      // Step 4: reasoning → DONE
      // Step 5: synthesis → final answer
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: '{"toolName":"rag_search","input":{"query":"test"},"reason":"Need info"}',
                      },
                    ],
                    role: "model",
                  },
                  finishReason: "STOP",
                  safetyRatings: [],
                },
              ],
              usageMetadata: {
                totalTokenCount: 100,
                promptTokenCount: 80,
                candidatesTokenCount: 20,
              },
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(makeSynthesisResponse("Draft answer")) // draft
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          contextRelevance: 0.9,
                          faithfulness: 0.9,
                          answerRelevance: 0.9,
                          shouldRetry: false,
                        }),
                      },
                    ],
                    role: "model",
                  },
                  finishReason: "STOP",
                  safetyRatings: [],
                },
              ],
              usageMetadata: {
                totalTokenCount: 80,
                promptTokenCount: 60,
                candidatesTokenCount: 20,
              },
            }),
            { status: 200 }
          )
        ) // quality evaluation (high score → no retry)
        .mockResolvedValueOnce(makeDoneDecisionResponse()) // reasoning → DONE
        .mockResolvedValueOnce(makeSynthesisResponse("The answer is 42.")) // final synthesis

      await service.run("What is ML?", "user-1", "session-1", onEvent)

      const completeEvent = emittedEvents.find(e => e.type === "complete")
      expect(completeEvent?.type).toBe("complete")
      if (completeEvent?.type === "complete") {
        expect(completeEvent.result.finalAnswer).toBe("The answer is 42.")
      }
    })
    it("emits 'status: generating' before 'complete'", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      await service.run("What is ML?", "user-1", "session-1", onEvent)

      const statusEvents = emittedEvents.filter(e => e.type === "status")
      const generatingIdx = statusEvents.findIndex(
        e => e.type === "status" && e.status === "generating"
      )
      const completeIdx = emittedEvents.findIndex(e => e.type === "complete")

      expect(generatingIdx).toBeGreaterThan(-1)
      expect(completeIdx).toBeGreaterThan(generatingIdx)
    })

    it("includes sessionId in status events", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      await service.run("What is ML?", "user-1", "my-session-123", onEvent)

      const statusEvent = emittedEvents.find(
        e => e.type === "status" && e.type === "status" && "sessionId" in e
      )
      if (statusEvent?.type === "status") {
        expect(statusEvent.sessionId).toBe("my-session-123")
      }
    })
  })

  // ── Return value ───────────────────────────────────────────────────────
  describe("return value", () => {
    it("returns an AgentResult with the correct sessionId", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      const result = await service.run("test", "user-1", "session-abc", onEvent)
      expect(result.sessionId).toBe("session-abc")
    })

    it("returns status: done", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      const result = await service.run("test", "user-1", "session-1", onEvent)
      expect(result.status).toBe("done")
    })

    it("has a positive durationMs", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      const result = await service.run("test", "user-1", "session-1", onEvent)
      expect(result.durationMs).toBeGreaterThan(0)
    })
  })

  // ── Callback robustness ────────────────────────────────────────────────
  describe("onEvent callback robustness", () => {
    it("does not throw if onEvent throws", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      const throwingCallback = (): void => {
        throw new Error("Callback error!")
      }

      // Should not propagate the callback error
      await expect(
        service.run("test", "user-1", "session-1", throwingCallback)
      ).resolves.toBeDefined()
    })

    it("emits events even after callback throws once", async () => {
      fetchSpy
        .mockResolvedValueOnce(makeDoneDecisionResponse())
        .mockResolvedValueOnce(makeSynthesisResponse())

      let callCount = 0
      const partiallyThrowingCallback = (msg: ServerMessage): void => {
        callCount++
        emittedEvents.push(msg)
        if (callCount === 1) throw new Error("First call throws")
        // subsequent calls succeed
      }

      await service.run("test", "user-1", "session-1", partiallyThrowingCallback)

      // Should have received more than just the first event
      expect(emittedEvents.length).toBeGreaterThan(1)
    })
  })
})
