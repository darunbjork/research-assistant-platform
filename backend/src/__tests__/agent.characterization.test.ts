import { AgentService } from "../services/agent.service"
import { StreamingAgentService } from "../services/streaming.agent.service"
import type { HybridSearchService } from "../services/hybrid.search.service"
import type { GenerationService } from "../services/generation.service"
import type { ServerMessage } from "../types/websocket.types"
import type { AgentResult } from "../types/agent.types"
import { RateLimitError } from "../middleware/error.middleware"
import {
  scriptGemini,
  decision,
  textResponse,
  evalResponse,
  http429,
  makeHybridResult,
  makeStubHybridSearch,
  makeStubGenerationService,
  normalizeResult,
  normalizeEvents,
  rateLimitError as rlError,
  type ScriptedResponse,
  type GeminiScriptHandle,
} from "./helpers/agent-script"

jest.setTimeout(10000)

const FIXED_SESSION = "session-fixed"

function makeServices(searchStub: { search: jest.Mock }): {
  hybrid: HybridSearchService
  generation: GenerationService
} {
  const hybrid = searchStub as unknown as HybridSearchService
  const generation = makeStubGenerationService() as unknown as GenerationService
  return { hybrid, generation }
}

async function runHttp(
  script: ScriptedResponse[],
  search: ReturnType<typeof makeStubHybridSearch>,
  query: string,
  signal?: AbortSignal
): Promise<{ result?: AgentResult; error?: unknown; script: GeminiScriptHandle }> {
  const { hybrid, generation } = makeServices(search)
  const s = scriptGemini(script)
  try {
    const svc = new AgentService("key", hybrid, generation)
    const result = await svc.run(query, "user-1", signal)
    return { result, script: s }
  } catch (error) {
    return { error, script: s }
  } finally {
    s.restore()
  }
}

async function runWs(
  script: ScriptedResponse[],
  search: ReturnType<typeof makeStubHybridSearch>,
  query: string,
  signal?: AbortSignal
): Promise<{
  result?: AgentResult
  error?: unknown
  events: ServerMessage[]
  script: GeminiScriptHandle
}> {
  const { hybrid, generation } = makeServices(search)
  const events: ServerMessage[] = []
  const onEvent = (m: ServerMessage): void => {
    events.push(m)
  }
  const s = scriptGemini(script)
  try {
    const svc = new StreamingAgentService("key", hybrid, generation)
    const result = await svc.run(query, "user-1", FIXED_SESSION, onEvent, signal)
    return { result, events, script: s }
  } catch (error) {
    return { error, events, script: s }
  } finally {
    s.restore()
  }
}

function kinds(s: GeminiScriptHandle): string[] {
  return s.records.map(r => r.kind)
}
function normErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}:${e.message}`
  return String(e)
}

function expectEqualOrExplain(httpN: unknown, wsN: unknown, scenario: string): void {
  try {
    expect(wsN).toEqual(httpN)
  } catch (e) {
    throw new Error(
      `HTTP vs WS normalized results differ in ${scenario}. Map to V-item or log V11+. ${(e as Error).message}`
    )
  }
}

describe("agent characterization (HTTP vs WS, pre-refactor)", () => {
  // S1: rag_search → quality >= 0.7 → done
  // Draft crafted borderline so LLM evaluate IS called and scripted explicitly (requirement C).
  test("S1 rag_search then quality >= 0.7 then done", async () => {
    const query = "what is alpha"
    const script: ScriptedResponse[] = [
      decision("rag_search", { query: "alpha" }, "search"),
      textResponse("Alpha is the answer. According to the document it states alpha clearly.", 80),
      evalResponse(0.9, { shouldRetry: false }),
      textResponse("Final answer about alpha.", 120),
    ]
    const mk = (): ReturnType<typeof makeStubHybridSearch> =>
      makeStubHybridSearch({
        results: [makeHybridResult({ content: "alpha evidence", source: "a.txt", rrfScore: 0.9 })],
      })
    const h = await runHttp(script, mk(), query)
    const w = await runWs(script, mk(), query)
    if (h.error || w.error) throw h.error ?? w.error
    const hn = normalizeResult(h.result!)
    const wn = normalizeResult(w.result!)
    expectEqualOrExplain(hn, wn, "S1")
    expect(kinds(h.script)).toEqual([
      "generateContent:reason",
      "generateContent:draft",
      "generateContent:evaluate",
      "generateContent:synthesis",
    ])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      http: hn,
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S1")
  })

  // S2: low quality with suggested query → second search with that query → done
  test("S2 low quality retry with suggested query then done", async () => {
    const query = "explain beta"
    const script: ScriptedResponse[] = [
      decision("rag_search", { query: "beta" }),
      textResponse("draft one", 50),
      evalResponse(0.4, {
        shouldRetry: true,
        retryReason: "need better query",
        suggestedQuery: "beta details",
      }),
      decision("rag_search", { query: "beta details" }),
      textResponse("draft two", 50),
      evalResponse(0.9, { shouldRetry: false }),
      textResponse("Final beta answer.", 80),
    ]
    const h = await runHttp(script, makeStubHybridSearch(), query)
    const w = await runWs(script, makeStubHybridSearch(), query)
    if (h.error || w.error) throw h.error ?? w.error
    const hn = normalizeResult(h.result!)
    const wn = normalizeResult(w.result!)
    expectEqualOrExplain(hn, wn, "S2")
    expect(kinds(h.script)).toEqual([
      "generateContent:reason",
      "generateContent:draft",
      "generateContent:evaluate",
      "generateContent:reason",
      "generateContent:draft",
      "generateContent:evaluate",
      "generateContent:synthesis",
    ])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      http: hn,
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S2")
  })

  // S3: model says DONE too early while unused suggested query exists → override → search
  test("S3 DONE overridden by unused suggested query", async () => {
    const query = "gamma topic"
    const script: ScriptedResponse[] = [
      decision("rag_search", { query: "gamma" }),
      textResponse("draft one", 50),
      evalResponse(0.4, {
        shouldRetry: true,
        retryReason: "try again",
        suggestedQuery: "gamma refined",
      }),
      decision("DONE", {}, "done too early"),
      textResponse("draft two", 50),
      evalResponse(0.9, { shouldRetry: false }),
      textResponse("Final gamma.", 80),
    ]
    const h = await runHttp(script, makeStubHybridSearch(), query)
    const w = await runWs(script, makeStubHybridSearch(), query)
    if (h.error || w.error) throw h.error ?? w.error
    const hn = normalizeResult(h.result!)
    const wn = normalizeResult(w.result!)
    expectEqualOrExplain(hn, wn, "S3")
    expect(kinds(h.script)).toEqual([
      "generateContent:reason",
      "generateContent:draft",
      "generateContent:evaluate",
      "generateContent:reason",
      "generateContent:draft",
      "generateContent:evaluate",
      "generateContent:synthesis",
    ])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      http: hn,
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S3")
  })

  // S4: DONE with no tool calls at all → deterministic no-information fallback
  test("S4 DONE with no tool calls uses fallback", async () => {
    const query = "unknown topic"
    const script: ScriptedResponse[] = [decision("DONE", {}, "nothing to search")]
    const h = await runHttp(script, makeStubHybridSearch(), query)
    const w = await runWs(script, makeStubHybridSearch(), query)
    if (h.error || w.error) throw h.error ?? w.error
    const hn = normalizeResult(h.result!)
    const wn = normalizeResult(w.result!)
    expectEqualOrExplain(hn, wn, "S4")
    expect(kinds(h.script)).toEqual(["generateContent:reason"])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      http: hn,
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S4")
  })

  // S5: calculator path
  test("S5 calculator path", async () => {
    const query = "compute 2+2"
    const script: ScriptedResponse[] = [
      decision("calculator", { expression: "2+2" }, "calc"),
      textResponse("The result is four. According to the document states 4.", 40),
      evalResponse(0.9, { shouldRetry: false }),
      textResponse("The result is 4.", 40),
    ]
    const h = await runHttp(script, makeStubHybridSearch(), query)
    const w = await runWs(script, makeStubHybridSearch(), query)
    if (h.error || w.error) throw h.error ?? w.error
    const hn = normalizeResult(h.result!)
    const wn = normalizeResult(w.result!)
    expectEqualOrExplain(hn, wn, "S5")
    expect(kinds(h.script)).toEqual([
      "generateContent:reason",
      "generateContent:draft",
      "generateContent:evaluate",
      "generateContent:synthesis",
    ])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      http: hn,
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S5")
  })

  // S6: MAX_ITERATIONS (5) reached
  // V11 (discovered): HTTP pushes eval steps with `toolUsed: undefined` (explicit key), WS omits it.
  // Normalization drops undefined keys; snapshot documents semantic equality of step content.
  test("S6 max iterations reached", async () => {
    const query = "loop forever"
    const script: ScriptedResponse[] = []
    for (let i = 1; i <= 5; i++) {
      script.push(decision("rag_search", { query: `q${i}` }))
      script.push(textResponse("draft", 30))
      script.push(
        evalResponse(0.4, { shouldRetry: true, retryReason: "low", suggestedQuery: `q${i + 1}` })
      )
    }
    script.push(textResponse("Final after max.", 60))
    const h = await runHttp(script, makeStubHybridSearch(), query)
    const w = await runWs(script, makeStubHybridSearch(), query)
    if (h.error || w.error) throw h.error ?? w.error
    const hn = normalizeResult(h.result!)
    const wn = normalizeResult(w.result!)
    expectEqualOrExplain(hn, wn, "S6")
    const expectedKinds = Array(5)
      .fill(["generateContent:reason", "generateContent:draft", "generateContent:evaluate"])
      .flat()
      .concat(["generateContent:synthesis"])
    expect(kinds(h.script)).toEqual(expectedKinds)
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      http: hn,
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S6")
  })

  // S7: malformed decision JSON → error
  test("S7 malformed decision JSON throws", async () => {
    const query = "bad json"
    const script: ScriptedResponse[] = [textResponse("not json at all", 20)]
    const h = await runHttp(script, makeStubHybridSearch(), query)
    const w = await runWs(script, makeStubHybridSearch(), query)
    expect(h.error).toBeTruthy()
    expect(w.error).toBeTruthy()
    expect(normErr(h.error)).toBe(normErr(w.error))
    expect(kinds(h.script)).toEqual(["generateContent:reason"])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      httpError: normErr(h.error),
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S7")
  })

  // S8: rag_search throws generic Error → failed step recorded, loop continues (V9 keeps this for non-abort/non-429)
  test("S8 rag_search generic error continues loop", async () => {
    const query = "tool error"
    const script: ScriptedResponse[] = [
      decision("rag_search", { query: "x" }),
      decision("DONE", {}, "give up"),
      textResponse("Final despite error.", 60),
    ]
    const h = await runHttp(
      script,
      makeStubHybridSearch({ error: new Error("search boom") }),
      query
    )
    const w = await runWs(script, makeStubHybridSearch({ error: new Error("search boom") }), query)
    if (h.error || w.error) throw h.error ?? w.error
    const hn = normalizeResult(h.result!)
    const wn = normalizeResult(w.result!)
    expectEqualOrExplain(hn, wn, "S8")
    expect(kinds(h.script)).toEqual([
      "generateContent:reason",
      "generateContent:reason",
      "generateContent:synthesis",
    ])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      http: hn,
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S8")
  })

  // S9: 429 during reasoning → RateLimitError propagates, no further calls (Retry-After: 0, no real sleep)
  test("S9 429 during reasoning propagates RateLimitError", async () => {
    const query = "rate limited"
    const script: ScriptedResponse[] = [http429(0), http429(0), http429(0)]
    const h = await runHttp(script, makeStubHybridSearch(), query)
    const w = await runWs(script, makeStubHybridSearch(), query)
    expect(h.error).toBeInstanceOf(RateLimitError)
    expect(w.error).toBeInstanceOf(RateLimitError)
    expect(normErr(h.error)).toBe(normErr(w.error))
    expect(kinds(h.script)).toEqual([
      "generateContent:reason",
      "generateContent:reason",
      "generateContent:reason",
    ])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      httpError: normErr(h.error),
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S9")
  })

  // S10: 429 raised inside rag_search (stub throws RateLimitError) → current (wrong) behaviour recorded (V9)
  test("S10 RateLimitError inside rag_search recorded as-is (V9 current behavior)", async () => {
    const query = "rl in tool"
    const script: ScriptedResponse[] = [
      decision("rag_search", { query: "x" }),
      decision("DONE", {}, "stop"),
      textResponse("Final after swallowed RL.", 60),
    ]
    const h = await runHttp(script, makeStubHybridSearch({ error: rlError("Gemini quota") }), query)
    const w = await runWs(script, makeStubHybridSearch({ error: rlError("Gemini quota") }), query)
    expect(h.error).toBeUndefined()
    expect(w.error).toBeUndefined()
    const hn = normalizeResult(h.result!)
    const wn = normalizeResult(w.result!)
    expectEqualOrExplain(hn, wn, "S10")
    expect(kinds(h.script)).toEqual([
      "generateContent:reason",
      "generateContent:reason",
      "generateContent:synthesis",
    ])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      http: hn,
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S10")
  })

  // S11: abort after iteration 1 tool execution completes → aborted result, no further fetch calls.
  // Search returns then signal is aborted: loop continues to draft, draftAnswer sees aborted and rethrows;
  // run catches and returns aborted with iterationCount=1 and no draft/eval/synthesis fetch calls.
  // (Tool does not yet receive signal — V10; this records pre-refactor behavior deterministically.)
  // V10: tool does not receive signal yet; abort is observed at draft step after tool returns.
  test("S11 abort after iteration 1 tool execution", async () => {
    const query = "abort after one"
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" })
    const ac = new AbortController()
    const search = makeStubHybridSearch({
      impl: async () => {
        ac.abort()
        return [makeHybridResult({ content: "evidence", source: "s.txt" })]
      },
    })
    const script: ScriptedResponse[] = [
      decision("rag_search", { query: "x" }),
      { kind: "throw", error: abortErr }, // draft fetch -> draftAnswer rethrows because signal aborted
    ]
    const h = await runHttp(script, search, query, ac.signal)
    const ac2 = new AbortController()
    const search2 = makeStubHybridSearch({
      impl: async () => {
        ac2.abort()
        return [makeHybridResult({ content: "evidence", source: "s.txt" })]
      },
    })
    const w = await runWs(script, search2, query, ac2.signal)
    expect(h.error).toBeUndefined()
    expect(w.error).toBeUndefined()
    const hn = normalizeResult(h.result!)
    const wn = normalizeResult(w.result!)
    expectEqualOrExplain(hn, wn, "S11")
    expect((h.result as AgentResult).status).toBe("aborted")
    expect(kinds(h.script)).toEqual(["generateContent:reason", "generateContent:draft"])
    expect(kinds(w.script)).toEqual(kinds(h.script))
    expect({
      http: hn,
      fetchKinds: kinds(h.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S11")
  })

  // S12: abort while rag_search is running → current behaviour recorded (V10)
  // Stub throws AbortError while signal aborted; tool catch currently swallows it (V9/V10).
  test("S12 abort while rag_search running recorded as-is (V10 current behavior)", async () => {
    const query = "abort in tool"
    const ac = new AbortController()
    ac.abort()
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" })
    const script: ScriptedResponse[] = [
      decision("rag_search", { query: "x" }),
      decision("DONE", {}, "stop"),
      textResponse("Final after swallowed abort.", 60),
    ]
    const h = await runHttp(script, makeStubHybridSearch({ error: abortErr }), query, ac.signal)
    const ac2 = new AbortController()
    ac2.abort()
    const w = await runWs(script, makeStubHybridSearch({ error: abortErr }), query, ac2.signal)
    const hSnap = h.error ? { httpError: normErr(h.error) } : { http: normalizeResult(h.result!) }
    const wSnap = w.error ? { wsError: normErr(w.error) } : { ws: normalizeResult(w.result!) }
    if (h.error || w.error) {
      expect(normErr(h.error)).toBe(normErr(w.error))
    } else {
      expectEqualOrExplain(normalizeResult(h.result!), normalizeResult(w.result!), "S12")
    }
    expect({
      ...hSnap,
      ...wSnap,
      fetchKinds: kinds(h.script),
      wsFetchKinds: kinds(w.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S12")
  })

  // S13: MAX_TOKENS Gemini response in draft. Current behavior: geminiText throws but draftAnswer swallows
  // non-abort/non-429 errors and returns "" so the loop continues (records current behavior; "explicit failure" not observed).
  test("S13 MAX_TOKENS draft response current behavior", async () => {
    const query = "draft fail"
    const maxTokensDraftBody = {
      candidates: [
        {
          content: { parts: [{ text: "partial" }], role: "model" },
          finishReason: "MAX_TOKENS",
          safetyRatings: [],
        },
      ],
      usageMetadata: { totalTokenCount: 10 },
    }
    const script: ScriptedResponse[] = [
      decision("rag_search", { query: "x" }),
      { kind: "json", body: maxTokensDraftBody }, // draft -> geminiText throws, draftAnswer swallows
      evalResponse(0.4, { shouldRetry: true, retryReason: "low", suggestedQuery: "q2" }),
      decision("DONE", {}, "stop"),
      textResponse("Final after truncated draft.", 60),
    ]
    const h = await runHttp(script, makeStubHybridSearch(), query)
    const w = await runWs(script, makeStubHybridSearch(), query)
    const hSnap = h.error ? { httpError: normErr(h.error) } : { http: normalizeResult(h.result!) }
    const wSnap = w.error ? { wsError: normErr(w.error) } : { ws: normalizeResult(w.result!) }
    if (h.error || w.error) {
      expect(normErr(h.error)).toBe(normErr(w.error))
    } else {
      expectEqualOrExplain(normalizeResult(h.result!), normalizeResult(w.result!), "S13")
    }
    expect({
      ...hSnap,
      ...wSnap,
      fetchKinds: kinds(h.script),
      wsFetchKinds: kinds(w.script),
      wsEvents: normalizeEvents(w.events),
    }).toMatchSnapshot("S13")
  })
})
