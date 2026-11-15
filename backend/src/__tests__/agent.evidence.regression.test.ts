import { AgentService } from "../services/agent.service"
import { StreamingAgentService } from "../services/streaming.agent.service"
import type { EvaluationContext } from "../agents/nodes/evaluate.node"
import type { GeminiRequest } from "../types/llm.types"
import { EvaluatorNode } from "../agents/nodes/evaluate.node"
import type { HybridSearchService } from "../services/hybrid.search.service"
import type { GenerationService } from "../services/generation.service"
import type { ServerMessage } from "../types/websocket.types"

function reply(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { totalTokenCount: 100 },
    })
  )
}

// Both transports must use the complete retrieved evidence and propagate model errors.
describe.each(["http", "websocket"])("%s agent regressions", transport => {
  const events: ServerMessage[] = []
  let fetchSpy: jest.SpyInstance
  let evaluateSpy: jest.SpyInstance
  let search: jest.Mock
  let run: () => ReturnType<AgentService["run"]>

  beforeEach(() => {
    events.length = 0
    search = jest.fn().mockResolvedValue([
      {
        rrfScore: 0.0164,
        chunk: {
          source: "manual.pdf",
          pageNumber: null,
          content: "Background. ".repeat(70) + "EXTRACTED_TEXT_PROOF: text extraction is complete.",
        },
      },
    ])
    const hybrid = { search } as unknown as HybridSearchService
    const generation = {} as GenerationService
    run =
      transport === "http"
        ? () => new AgentService("key", hybrid, generation).run("Was text extracted?", "user")
        : () =>
            new StreamingAgentService("key", hybrid, generation).run(
              "Was text extracted?",
              "user",
              "session",
              event => events.push(event)
            )
    fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected model call"))
    evaluateSpy = jest.spyOn(EvaluatorNode.prototype, "evaluate").mockResolvedValue({
      tokensUsed: 40,
      overallScore: 0.9,
      contextRelevance: 0.9,
      faithfulness: 0.9,
      answerRelevance: 0.9,
      shouldRetry: false,
      retryReason: "",
      evaluationMethod: "heuristic",
    })
  })

  afterEach(() => jest.restoreAllMocks())

  it("includes later search results in the draft and returns actual token usage", async () => {
    fetchSpy
      .mockResolvedValueOnce(reply('{"toolName":"rag_search","input":{"query":"extracted"}}'))
      .mockResolvedValueOnce(reply("The document confirms text extraction."))
      .mockResolvedValueOnce(reply("Text extraction is complete. [Evidence 1]"))
    const result = await run()
    const calls = fetchSpy.mock.calls as [unknown, RequestInit][]
    const draftRequest = JSON.parse(String(calls[1]?.[1].body)) as GeminiRequest
    expect(draftRequest.contents[0]?.parts[0]?.text).toContain("EXTRACTED_TEXT_PROOF")
    expect(
      (evaluateSpy.mock.calls as [EvaluationContext][])[0]?.[0].toolCallHistory[0]?.output
    ).toContain("EXTRACTED_TEXT_PROOF")
    expect(result.tokensUsed).toBe(340)
    expect(result.status).toBe("done")
    expect(search).toHaveBeenCalledWith(
      "extracted",
      expect.objectContaining({ userId: "user" }),
      undefined
    )
  })

  it("honours an unused suggested search when the model prematurely says DONE", async () => {
    evaluateSpy.mockResolvedValueOnce({
      overallScore: 0.4,
      shouldRetry: true,
      retryReason: "Missing extraction evidence",
      suggestedQuery: "extraction proof",
      evaluationMethod: "heuristic",
    })
    fetchSpy
      .mockResolvedValueOnce(reply('{"toolName":"rag_search","input":{"query":"extracted"}}'))
      .mockResolvedValueOnce(reply("Partial evidence."))
      .mockResolvedValueOnce(reply('{"toolName":"DONE","input":{}}'))
      .mockResolvedValueOnce(reply("Complete evidence."))
      .mockResolvedValueOnce(reply("Extraction confirmed."))
    await run()
    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenLastCalledWith(
      "extraction proof",
      expect.objectContaining({ userId: "user" }),
      undefined
    )
  })

  it("does not draft or evaluate a failed search as successful evidence", async () => {
    search.mockRejectedValueOnce(new Error("SEARCH_FAILURE_MARKER"))
    fetchSpy
      .mockResolvedValueOnce(reply('{"toolName":"rag_search","input":{"query":"extracted"}}'))
      .mockResolvedValueOnce(reply('{"toolName":"DONE","input":{}}'))
      .mockResolvedValueOnce(reply("Insufficient evidence."))
    await run()
    expect(evaluateSpy).not.toHaveBeenCalled()
    const calls = fetchSpy.mock.calls as [unknown, RequestInit][]
    expect(calls).toHaveLength(3)
    const synthesis = JSON.parse(String(calls[2]?.[1].body)) as GeminiRequest
    expect(synthesis.contents[0]?.parts[0]?.text).not.toContain("SEARCH_FAILURE_MARKER")
  })

  it("does not complete successfully after malformed reasoning", async () => {
    fetchSpy.mockResolvedValueOnce(reply("invalid JSON"))
    await expect(run()).rejects.toThrow("invalid tool decision")
    expect(events.some(event => event.type === "complete")).toBe(false)
    expect(search).not.toHaveBeenCalled()
  })
})
