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

interface TestSpan {
  setAttribute: (k: string, v: unknown) => void
  setStatus: () => void
  recordException: () => void
  end: () => void
}

interface SpanRecord {
  name: string
  attrs: Record<string, unknown>
}

// Capture spans recorded by withSpan (engine spans flow through mocked withSpan)
const spanRecords: SpanRecord[] = []

// withSpan is imported from ../telemetry/spans by engine; mock to capture span attrs
jest.mock("../telemetry/spans", () => {
  const actual = jest.requireActual<typeof import("../telemetry/spans")>("../telemetry/spans")
  return {
    ...actual,
    withSpan: async (
      _tracer: unknown,
      name: string,
      fn: (span: TestSpan) => Promise<unknown>,
      attributes: Record<string, unknown> = {}
    ): Promise<unknown> => {
      const attrs: Record<string, unknown> = { ...attributes }
      const span: TestSpan = {
        setAttribute: (k: string, v: unknown): void => {
          attrs[k] = v
        },
        setStatus: (): void => {},
        recordException: (): void => {},
        end: (): void => {},
      }
      spanRecords.push({ name, attrs })
      return fn(span)
    },
  }
})

jest.setTimeout(10000)

async function gaugeValue(): Promise<number> {
  const result = await activeAgentSessions.get()
  return result.values[0]?.value ?? 0
}

function makeEngine(
  searchResults = [makeHybridResult({ content: "evidence", source: "a.txt", rrfScore: 0.9 })]
): { engine: AgentEngine } {
  const hybrid = makeStubHybridSearch({ results: searchResults }) as unknown as HybridSearchService
  const generation = makeStubGenerationService() as unknown as GenerationService
  const engine = new AgentEngine("key", hybrid, generation)
  return { engine }
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
      expect(events.some(e => e.type === "complete")).toBe(true)
    } finally {
      s.restore()
    }
  })

  test("increments activeAgentSessions during run and restores after success", async () => {
    const before = await gaugeValue()
    const { engine } = makeEngine()
    let during = -1
    const onEvent = (m: ServerMessage): void => {
      if (m.type === "step" && during === -1) {
        void gaugeValue().then(v => {
          during = v
        })
      }
    }
    const s = scriptGemini(baseScript)
    try {
      await engine.run({
        query: "q",
        userId: "u",
        sessionId: "s1",
        transport: "ws",
        onEvent,
      })
      // allow microtask from gaugeValue().then to flush
      await Promise.resolve()
      expect(during).toBe(before + 1)
      expect(await gaugeValue()).toBe(before)
    } finally {
      s.restore()
    }
  })

  test("restores activeAgentSessions after abort", async () => {
    const before = await gaugeValue()
    const { engine } = makeEngine()
    const controller = new AbortController()
    controller.abort()
    const s = scriptGemini([])
    try {
      const result = await engine.run({
        query: "q",
        userId: "u",
        sessionId: "s2",
        transport: "ws",
        signal: controller.signal,
        onEvent: (): void => {},
      })
      expect(result.status).toBe("aborted")
      expect(await gaugeValue()).toBe(before)
    } finally {
      s.restore()
    }
  })

  test("increments activeAgentSessions during run and restores after error", async () => {
    const before = await gaugeValue()
    const { engine } = makeEngine()
    let during = -1
    const onEvent = (m: ServerMessage): void => {
      if (m.type === "step" && during === -1) {
        void gaugeValue().then(v => {
          during = v
        })
      }
    }
    // rag_search -> step emitted, draft ok, eval ok (>=0.7 ends loop), synthesis throws -> error after step
    const script: ScriptedResponse[] = [
      decision("rag_search", { query: "alpha" }, "search"),
      textResponse("Alpha is the answer. According to the document it states alpha clearly.", 80),
      evalResponse(0.9, { shouldRetry: false }),
      { kind: "throw", error: new Error("boom") },
    ]
    const s = scriptGemini(script)
    try {
      await expect(
        engine.run({ query: "q", userId: "u", sessionId: "s3", transport: "ws", onEvent })
      ).rejects.toThrow("boom")
      await Promise.resolve()
      expect(during).toBe(before + 1)
      expect(await gaugeValue()).toBe(before)
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
        onEvent: (e): void => {
          events.push(e)
        },
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
