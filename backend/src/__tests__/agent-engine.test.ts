import { AgentEngine } from "../agents/engine/agent-engine"
import type { HybridSearchService } from "../services/hybrid.search.service"
import type { GenerationService } from "../services/generation.service"
import type { ServerMessage } from "../types/websocket.types"
import { activeAgentSessions } from "../utils/metrics"
import {
  scriptGemini,
  decision,
  textResponse,
  evalResponse,
  makeHybridResult,
  makeStubHybridSearch,
  makeStubGenerationService,
  type ScriptedResponse,
} from "./helpers/agent-script"

// Capture spans recorded by AgentEngine (it does getTracer("agent.engine") in ctor)
const spanRecords: Array<{ name: string; attrs: Record<string, unknown> }> = []

jest.mock("../telemetry/tracer", () => ({
  getTracer: () => ({
    startActiveSpan: async (name: string, fn: (span: any) => Promise<any>) => {
      const attrs: Record<string, unknown> = {}
      const span = {
        setAttribute: (k: string, v: unknown) => {
          attrs[k] = v
        },
        setStatus: () => {},
        recordException: () => {},
        end: () => {},
      }
      spanRecords.push({ name, attrs })
      try {
        return await fn(span)
      } finally {
        // end already callable; no-op
      }
    },
  }),
}))

// withSpan is imported from ../telemetry/spans by engine; mock to use our tracer shape directly
jest.mock("../telemetry/spans", () => {
  const actual = jest.requireActual("../telemetry/spans")
  return {
    ...actual,
    withSpan: async (
      _tracer: unknown,
      name: string,
      fn: (span: any) => Promise<any>,
      attributes: Record<string, any> = {}
    ) => {
      const attrs: Record<string, unknown> = { ...attributes }
      const span = {
        setAttribute: (k: string, v: unknown) => {
          attrs[k] = v
        },
        setStatus: () => {},
        recordException: () => {},
        end: () => {},
      }
      spanRecords.push({ name, attrs })
      return fn(span)
    },
  }
})

jest.setTimeout(10000)

function gaugeValue(): number {
  const g: any = activeAgentSessions
  // prom-client Gauge stores labeled/unlabeled values in hashMap
  if (g.hashMap && g.hashMap[""] && typeof g.hashMap[""].value === "number") {
    return g.hashMap[""].value as number
  }
  // fallback: try get()
  if (typeof g.get === "function") {
    const v = g.get()
    if (v && Array.isArray(v.values) && v.values[0]) return v.values[0].value as number
  }
  return 0
}

function makeEngine(searchResults = [makeHybridResult({ content: "evidence", source: "a.txt", rrfScore: 0.9 })]) {
  const hybrid = makeStubHybridSearch({ results: searchResults }) as unknown as HybridSearchService
  const generation = makeStubGenerationService() as unknown as GenerationService
  const engine = new AgentEngine("key", hybrid, generation)
  return { engine, hybrid, generation }
}

const baseScript: ScriptedResponse[] = [
  decision("rag_search", { query: "alpha" }, "search"),
  textResponse("Alpha is the answer. According to the document it states alpha clearly.", 80),
  evalResponse(0.9, { shouldRetry: false }),
  textResponse("Final answer about alpha.", 120),
]

describe("AgentEngine (Phase 4)", () => {
  beforeEach(() => {
    spanRecords.length = 0
    // reset gauge to 0 for isolation
    const g: any = activeAgentSessions
    if (g.hashMap) {
      for (const k of Object.keys(g.hashMap)) g.hashMap[k].value = 0
    } else if (typeof g.set === "function") {
      g.set(0)
    }
  })

  test("runs with no onEvent sink (HTTP-style) and returns done result", async () => {
    const { engine } = makeEngine()
    const s = scriptGemini(baseScript)
    try {
      const result = await engine.run({
        query: "what is alpha",
        userId: "user-1",
        sessionId: "sess-1",
        transport: "http",
      })
      expect(result.status).toBe("done")
      expect(result.sessionId).toBe("sess-1")
      expect(result.finalAnswer.length).toBeGreaterThan(0)
    } finally {
      s.restore()
    }
  })

  test("tolerates throwing onEvent callback", async () => {
    const { engine } = makeEngine()
    const events: ServerMessage[] = []
    const onEvent = (m: ServerMessage): void => {
      events.push(m)
      throw new Error("sink boom")
    }
    const s = scriptGemini(baseScript)
    try {
      const result = await engine.run({
        query: "what is alpha",
        userId: "user-1",
        sessionId: "sess-2",
        transport: "ws",
        onEvent,
      })
      expect(result.status).toBe("done")
      expect(events.length).toBeGreaterThan(0)
    } finally {
      s.restore()
    }
  })

  test("restores activeAgentSessions after success", async () => {
    const before = gaugeValue()
    const { engine } = makeEngine()
    const s = scriptGemini(baseScript)
    try {
      await engine.run({ query: "q", userId: "u", sessionId: "s1", transport: "http" })
      expect(gaugeValue()).toBe(before)
    } finally {
      s.restore()
    }
  })

  test("restores activeAgentSessions after abort", async () => {
    const before = gaugeValue()
    const { engine } = makeEngine()
    const controller = new AbortController()
    controller.abort()
    const s = scriptGemini([]) // should not be called
    try {
      const result = await engine.run({
        query: "q",
        userId: "u",
        sessionId: "s2",
        transport: "ws",
        signal: controller.signal,
        onEvent: () => {},
      })
      expect(result.status).toBe("aborted")
      expect(gaugeValue()).toBe(before)
    } finally {
      s.restore()
    }
  })

  test("restores activeAgentSessions after error", async () => {
    const before = gaugeValue()
    const { engine } = makeEngine()
    // reasoning call fails with non-abort error -> engine rethrows
    const s = scriptGemini([{ kind: "throw", error: new Error("boom") }])
    try {
      await expect(
        engine.run({ query: "q", userId: "u", sessionId: "s3", transport: "http" })
      ).rejects.toThrow("boom")
      expect(gaugeValue()).toBe(before)
    } finally {
      s.restore()
    }
  })

  test("records spans for WS-style run including agent.transport and tool/reason", async () => {
    const { engine } = makeEngine()
    const events: ServerMessage[] = []
    const s = scriptGemini(baseScript)
    try {
      await engine.run({
        query: "what is alpha",
        userId: "user-1",
        sessionId: "sess-span",
        transport: "ws",
        onEvent: e => events.push(e),
      })
    } finally {
      s.restore()
    }
    const names = spanRecords.map(r => r.name)
    expect(names).toContain("agent.run")
    expect(names).toContain("agent.reason")
    expect(names).toContain("agent.tool.rag_search")
    const run = spanRecords.find(r => r.name === "agent.run")
    expect(run?.attrs["agent.transport"]).toBe("ws")
    expect(run?.attrs["agent.session_id"]).toBe("sess-span")
  })
})
