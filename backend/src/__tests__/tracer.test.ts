// // backend/src/__tests__/tracer.test.ts
// import { withSpan, withSyncSpan, addSpanAttributes, LLM_ATTRS } from "../telemetry/spans"
// import { getTracer } from "../telemetry/tracer"

// // ── Complete OpenTelemetry API Mock ─────────────────────────────────────
// jest.mock("@opentelemetry/api", () => {
//   const mockSpan = {
//     setAttribute: jest.fn(),
//     setStatus: jest.fn(),
//     recordException: jest.fn(),
//     end: jest.fn(),
//     spanContext: jest.fn().mockReturnValue({
//       traceId: "abc123def456abc123def456abc12345",
//       spanId: "abc123def456abc1",
//     }),
//   }

//   const mockTracer = {
//     startActiveSpan: jest
//       .fn()
//       .mockImplementation((_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan)),
//   }

//   return {
//     trace: {
//       getTracer: jest.fn().mockReturnValue(mockTracer),
//       getActiveSpan: jest.fn().mockReturnValue(mockSpan),
//     },
//     context: {
//       with: jest.fn().mockImplementation((_ctx: unknown, fn: () => unknown) => fn()),
//       createContextKey: jest.fn().mockReturnValue(Symbol("context-key")),
//     },
//     SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
//     propagation: {
//       getBaggage: jest.fn(),
//       setBaggage: jest.fn(),
//     },
//   }
// })

// jest.mock("@opentelemetry/sdk-node", () => ({
//   NodeSDK: jest.fn().mockImplementation(() => ({
//     start: jest.fn(),
//     shutdown: jest.fn().mockResolvedValue(undefined),
//   })),
// }))

// // ── Test Helpers ───────────────────────────────────────────────────────
// const getMockSpan = () => {
//   const { trace } = jest.requireMock("@opentelemetry/api")
//   return trace.getActiveSpan()
// }

// // ── Tests ─────────────────────────────────────────────────────────────────
// describe("withSpan()", () => {
//   let mockSpan: ReturnType<typeof getMockSpan>

//   beforeEach(() => {
//     jest.clearAllMocks()
//     mockSpan = getMockSpan()
//   })

//   it("returns the result of the wrapped function", async () => {
//     const tracer = getTracer("test")
//     const result = await withSpan(tracer, "test.op", async () => "expected-result")
//     expect(result).toBe("expected-result")
//   })

//   it("calls span.end() after the function completes", async () => {
//     const tracer = getTracer("test")
//     await withSpan(tracer, "test.op", async () => "result")
//     expect(mockSpan.end).toHaveBeenCalledTimes(1)
//   })

//   it("calls span.end() even when function throws", async () => {
//     const tracer = getTracer("test")
//     await expect(
//       withSpan(tracer, "test.op", async () => {
//         throw new Error("test error")
//       })
//     ).rejects.toThrow("test error")
//     expect(mockSpan.end).toHaveBeenCalledTimes(1)
//   })

//   it("sets initial attributes on the span", async () => {
//     const tracer = getTracer("test")
//     await withSpan(tracer, "test.op", async () => "ok", {
//       [LLM_ATTRS.MODEL]: "test-model",
//       "custom.attr": 42,
//     })
//     expect(mockSpan.setAttribute).toHaveBeenCalledWith(LLM_ATTRS.MODEL, "test-model")
//     expect(mockSpan.setAttribute).toHaveBeenCalledWith("custom.attr", 42)
//   })

//   // ... (keep all your other tests as-is)
//   it("records the exception on the span when function throws", async () => {
//     const tracer = getTracer("test")
//     const testError = new Error("captured error")
//     await expect(
//       withSpan(tracer, "test.op", async () => {
//         throw testError
//       })
//     ).rejects.toThrow()
//     expect(mockSpan.recordException).toHaveBeenCalledWith(testError)
//   })

//   it("sets ERROR status on the span when function throws", async () => {
//     const tracer = getTracer("test")
//     await expect(
//       withSpan(tracer, "test.op", async () => {
//         throw new Error("failure")
//       })
//     ).rejects.toThrow()
//     expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: 2 }))
//   })

//   it("sets OK status on the span when function succeeds", async () => {
//     const tracer = getTracer("test")
//     await withSpan(tracer, "test.op", async () => "ok")
//     expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: 1 }))
//   })

//   it("passes the span to the callback function", async () => {
//     const tracer = getTracer("test")
//     let capturedSpan: unknown = null
//     await withSpan(tracer, "test.op", async span => {
//       capturedSpan = span
//       return "ok"
//     })
//     expect(capturedSpan).toBe(mockSpan)
//   })
// })

// describe("withSyncSpan()", () => {
//   let mockSpan: ReturnType<typeof getMockSpan>

//   beforeEach(() => {
//     jest.clearAllMocks()
//     mockSpan = getMockSpan()
//   })

//   it("returns the synchronous result", () => {
//     const tracer = getTracer("test")
//     const result = withSyncSpan(tracer, "sync.op", () => 42)
//     expect(result).toBe(42)
//   })

//   it("ends the span after synchronous completion", () => {
//     const tracer = getTracer("test")
//     withSyncSpan(tracer, "sync.op", () => "result")
//     expect(mockSpan.end).toHaveBeenCalledTimes(1)
//   })
// })

// describe("addSpanAttributes()", () => {
//   let mockSpan: ReturnType<typeof getMockSpan>

//   beforeEach(() => {
//     jest.clearAllMocks()
//     mockSpan = getMockSpan()
//   })

//   it("sets attributes on the active span", () => {
//     addSpanAttributes({ "test.key": "test.value", "test.num": 42 })
//     expect(mockSpan.setAttribute).toHaveBeenCalledWith("test.key", "test.value")
//     expect(mockSpan.setAttribute).toHaveBeenCalledWith("test.num", 42)
//   })

//   it("does not throw when there is no active span", () => {
//     const { trace } = jest.requireMock("@opentelemetry/api")
//     trace.getActiveSpan.mockReturnValueOnce(null)
//     expect(() => addSpanAttributes({ key: "value" })).not.toThrow()
//   })
// })

// describe("LLM_ATTRS semantic constants", () => {
//   it("follows OpenTelemetry GenAI semantic conventions", () => {
//     expect(LLM_ATTRS.MODEL).toBe("gen_ai.request.model")
//     expect(LLM_ATTRS.TOTAL_TOKENS).toBe("gen_ai.usage.total_tokens")
//     expect(LLM_ATTRS.OPERATION).toBe("gen_ai.operation.name")
//   })
// })

// backend/src/__tests__/tracer.test.ts
// Complete rewrite that avoids Temporal Dead Zone errors.
//
// ROOT CAUSE OF TDZ:
//   jest.mock() calls are hoisted to the TOP of the file by Babel/ts-jest,
//   BEFORE any let/const declarations run.
//   If the mock factory references a variable (mockSpan, mockTracer),
//   that variable doesn't exist yet → TDZ ReferenceError.
//
// FIX: define everything INSIDE the factory function, inline.
//   Never reference outer variables inside jest.mock() factories.

// ── Mock ALL OpenTelemetry packages BEFORE any imports ────────────────────
// These must be at the top, before any imports that trigger OTel code.

jest.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: jest.fn().mockImplementation(() => ({
    start:    jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined)
  }))
}))

jest.mock("@opentelemetry/resources", () => ({
  Resource: jest.fn().mockImplementation(() => ({
    merge: jest.fn().mockReturnThis()
  }))
}))

jest.mock("@opentelemetry/semantic-conventions", () => ({
  SEMRESATTRS_SERVICE_NAME:           "service.name",
  SEMRESATTRS_SERVICE_VERSION:        "service.version",
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT: "deployment.environment"
}))

jest.mock("@opentelemetry/sdk-trace-base", () => ({
  SimpleSpanProcessor: jest.fn().mockImplementation(() => ({})),
  BatchSpanProcessor:  jest.fn().mockImplementation(() => ({})),
  ConsoleSpanExporter: jest.fn().mockImplementation(() => ({})),
  AlwaysOnSampler:     jest.fn().mockImplementation(() => ({}))
}))

jest.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: jest.fn().mockImplementation(() => ({}))
}))

jest.mock("@opentelemetry/exporter-trace-otlp-grpc", () => ({
  OTLPTraceExporter: jest.fn().mockImplementation(() => ({}))
}))

jest.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: jest.fn().mockReturnValue([])
}))

// ── Mock @opentelemetry/api — the most important one ──────────────────────
// ALL mock objects are defined INSIDE the factory (no outer variable refs).
jest.mock("@opentelemetry/api", () => {
  // Define mock objects INSIDE the factory to avoid TDZ
  const mockSpanInstance = {
    setAttribute:    jest.fn().mockReturnThis(),
    setStatus:       jest.fn().mockReturnThis(),
    recordException: jest.fn().mockReturnThis(),
    end:             jest.fn(),
    spanContext:     jest.fn().mockReturnValue({
      traceId:    "abc123def456abc123def456abc12345",
      spanId:     "abc123def456abc1",
      traceFlags: 1
    }),
    isRecording: jest.fn().mockReturnValue(true)
  }

  const mockTracerInstance = {
    startActiveSpan: jest.fn().mockImplementation(
      (_name: string, fn: (span: typeof mockSpanInstance) => unknown) =>
        fn(mockSpanInstance)
    ),
    startSpan: jest.fn().mockReturnValue(mockSpanInstance)
  }

  return {
    trace: {
      getTracer:     jest.fn().mockReturnValue(mockTracerInstance),
      getActiveSpan: jest.fn().mockReturnValue(mockSpanInstance),
      setSpan:       jest.fn(),
      deleteSpan:    jest.fn()
    },
    context: {
      active:   jest.fn().mockReturnValue({}),
      with:     jest.fn().mockImplementation(
        (_ctx: unknown, fn: () => unknown) => fn()
      ),
      bind:     jest.fn(),
      disable:  jest.fn()
    },
    propagation: {
      inject:  jest.fn(),
      extract: jest.fn()
    },
    SpanStatusCode: {
      UNSET: 0,
      OK:    1,
      ERROR: 2
    },
    SpanKind: {
      INTERNAL: 0,
      SERVER:   1,
      CLIENT:   2,
      PRODUCER: 3,
      CONSUMER: 4
    },
    diag: {
      setLogger:   jest.fn(),
      error:       jest.fn(),
      warn:        jest.fn(),
      info:        jest.fn(),
      debug:       jest.fn(),
      verbose:     jest.fn()
    }
  }
})

// ── Now safe to import — OTel is fully mocked ─────────────────────────────
import { withSpan, withSyncSpan, addSpanAttributes, LLM_ATTRS, RAG_ATTRS } from "../telemetry/spans"
import { getTracer } from "../telemetry/tracer"

// ── Helpers: get the mock instances from the mocked module ────────────────
function getMockSpan() {
  const { trace } = jest.requireMock("@opentelemetry/api") as {
    trace: { getActiveSpan: jest.Mock }
  }
  return trace.getActiveSpan()
}

function getMockTracer() {
  const { trace } = jest.requireMock("@opentelemetry/api") as {
    trace: { getTracer: jest.Mock }
  }
  return trace.getTracer("test") as {
    startActiveSpan: jest.Mock
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("withSpan()", () => {
  beforeEach(() => {
    jest.clearAllMocks()

    // Re-configure startActiveSpan to call the callback with the mock span
    const mockSpan = getMockSpan()
    getMockTracer().startActiveSpan.mockImplementation(
      (_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan)
    )
  })

  it("returns the result of the wrapped function", async () => {
    const tracer = getTracer("test")
    const result = await withSpan(tracer, "test.op", async () => "expected-result")
    expect(result).toBe("expected-result")
  })

  it("calls span.end() after the function completes", async () => {
    const tracer   = getTracer("test")
    const mockSpan = getMockSpan()

    await withSpan(tracer, "test.op", async () => "result")

    expect(mockSpan.end).toHaveBeenCalledTimes(1)
  })

  it("calls span.end() even when the function throws", async () => {
    const tracer   = getTracer("test")
    const mockSpan = getMockSpan()

    await expect(
      withSpan(tracer, "test.op", async () => {
        throw new Error("test error")
      })
    ).rejects.toThrow("test error")

    // CRITICAL: span.end() must be called even on error
    expect(mockSpan.end).toHaveBeenCalledTimes(1)
  })

  it("sets initial attributes on the span", async () => {
    const tracer   = getTracer("test")
    const mockSpan = getMockSpan()

    await withSpan(
      tracer,
      "test.op",
      async () => "ok",
      { [LLM_ATTRS.MODEL]: "test-model", "custom.attr": 42 }
    )

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(LLM_ATTRS.MODEL, "test-model")
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("custom.attr", 42)
  })

  it("records the exception on the span when function throws", async () => {
    const tracer    = getTracer("test")
    const mockSpan  = getMockSpan()
    const testError = new Error("captured error")

    await expect(
      withSpan(tracer, "test.op", async () => { throw testError })
    ).rejects.toThrow()

    expect(mockSpan.recordException).toHaveBeenCalledWith(testError)
  })

  it("sets ERROR status when function throws", async () => {
    const tracer   = getTracer("test")
    const mockSpan = getMockSpan()

    await expect(
      withSpan(tracer, "test.op", async () => { throw new Error("failure") })
    ).rejects.toThrow()

    expect(mockSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: 2 })  // SpanStatusCode.ERROR = 2
    )
  })

  it("sets OK status when function succeeds", async () => {
    const tracer   = getTracer("test")
    const mockSpan = getMockSpan()

    await withSpan(tracer, "test.op", async () => "ok")

    expect(mockSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1 })  // SpanStatusCode.OK = 1
    )
  })

  it("re-throws the original error type", async () => {
    const tracer    = getTracer("test")
    const customErr = new TypeError("type mismatch")

    await expect(
      withSpan(tracer, "test.op", async () => { throw customErr })
    ).rejects.toBeInstanceOf(TypeError)
  })

  it("passes the span to the callback function", async () => {
    const tracer    = getTracer("test")
    const mockSpan  = getMockSpan()
    let capturedSpan: unknown = null

    await withSpan(tracer, "test.op", async (span) => {
      capturedSpan = span
      return "ok"
    })

    expect(capturedSpan).toBe(mockSpan)
  })

  it("works with zero initial attributes (no attributes arg)", async () => {
    const tracer = getTracer("test")
    await expect(
      withSpan(tracer, "test.op", async () => "ok")
    ).resolves.toBe("ok")
  })
})

// ── withSyncSpan() ─────────────────────────────────────────────────────────
describe("withSyncSpan()", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    const mockSpan = getMockSpan()
    getMockTracer().startActiveSpan.mockImplementation(
      (_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan)
    )
  })

  it("returns the synchronous result", () => {
    const tracer = getTracer("test")
    const result = withSyncSpan(tracer, "sync.op", () => 42)
    expect(result).toBe(42)
  })

  it("ends the span after synchronous completion", () => {
    const tracer   = getTracer("test")
    const mockSpan = getMockSpan()

    withSyncSpan(tracer, "sync.op", () => "result")

    expect(mockSpan.end).toHaveBeenCalledTimes(1)
  })

  it("ends the span even when the synchronous function throws", () => {
    const tracer   = getTracer("test")
    const mockSpan = getMockSpan()

    expect(() =>
      withSyncSpan(tracer, "sync.op", () => {
        throw new Error("sync error")
      })
    ).toThrow("sync error")

    expect(mockSpan.end).toHaveBeenCalledTimes(1)
  })

  it("sets ERROR status on sync throw", () => {
    const tracer   = getTracer("test")
    const mockSpan = getMockSpan()

    expect(() =>
      withSyncSpan(tracer, "sync.op", () => { throw new Error("oops") })
    ).toThrow()

    expect(mockSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: 2 })
    )
  })
})

// ── addSpanAttributes() ────────────────────────────────────────────────────
describe("addSpanAttributes()", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("sets attributes on the active span", () => {
    const mockSpan = getMockSpan()
    addSpanAttributes({ "test.key": "test.value", "test.num": 42 })

    expect(mockSpan.setAttribute).toHaveBeenCalledWith("test.key", "test.value")
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("test.num", 42)
  })

  it("does not throw when there is no active span", () => {
    const { trace: otelTrace } = jest.requireMock("@opentelemetry/api") as {
      trace: { getActiveSpan: jest.Mock }
    }
    otelTrace.getActiveSpan.mockReturnValueOnce(undefined)

    expect(() => addSpanAttributes({ key: "value" })).not.toThrow()
  })

  it("does not throw when active span is null", () => {
    const { trace: otelTrace } = jest.requireMock("@opentelemetry/api") as {
      trace: { getActiveSpan: jest.Mock }
    }
    otelTrace.getActiveSpan.mockReturnValueOnce(null)

    expect(() => addSpanAttributes({ key: "value" })).not.toThrow()
  })
})

// ── LLM_ATTRS semantic constants ───────────────────────────────────────────
describe("LLM_ATTRS semantic constants", () => {
  it("follows OpenTelemetry GenAI semantic conventions", () => {
    expect(LLM_ATTRS.MODEL).toBe("gen_ai.request.model")
    expect(LLM_ATTRS.TOTAL_TOKENS).toBe("gen_ai.usage.total_tokens")
    expect(LLM_ATTRS.OPERATION).toBe("gen_ai.operation.name")
    expect(LLM_ATTRS.SYSTEM).toBe("gen_ai.system")
  })

  it("RAG_ATTRS follows custom rag namespace", () => {
    expect(RAG_ATTRS.QUERY).toBe("rag.query")
    expect(RAG_ATTRS.CACHE_HIT).toBe("rag.cache.hit")
    expect(RAG_ATTRS.CHUNKS_RETRIEVED).toBe("rag.chunks.retrieved")
  })
})