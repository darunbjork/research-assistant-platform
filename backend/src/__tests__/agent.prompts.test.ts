import type { AgentState } from "../types/agent.types"
import type { ToolRegistry } from "../agents/tools/index"
import {
  buildDraftPrompt,
  buildReasoningPrompt,
  buildSynthesisPrompt,
} from "../agents/engine/prompts"
import type { EvaluationResult } from "../agents/nodes/evaluate.node"

function makeState(): AgentState {
  return {
    sessionId: "s1",
    userQuery: "What is the capital of France?",
    taskType: "rag_search",
    searchResults: [],
    toolCallHistory: [
      {
        toolName: "rag_search",
        input: { query: "capital of France" },
        output: "[Result 1] (source: geo.txt, relevance: 0.9000)\nParis is the capital of France.",
        durationMs: 10,
        timestamp: new Date("2026-01-01T00:00:00Z"),
        success: true,
      },
    ],
    draftAnswer: "",
    finalAnswer: "",
    citations: [],
    iterationCount: 1,
    isComplete: false,
    qualityScore: 0,
    status: "thinking",
    startedAt: new Date("2026-01-01T00:00:00Z"),
  }
}

const tools: ToolRegistry = {
  rag_search: {
    name: "rag_search",
    description: "Search docs",
    execute: async (): Promise<string> => "",
  },
  calculator: {
    name: "calculator",
    description: "Do math",
    execute: async (): Promise<string> => "",
  },
}

const lastEval: EvaluationResult = {
  overallScore: 0.4,
  contextRelevance: 0.4,
  faithfulness: 0.4,
  answerRelevance: 0.4,
  shouldRetry: true,
  retryReason: "need more detail",
  suggestedQuery: "capital city of France details",
  evaluationMethod: "heuristic",
}

describe("agent prompt builders (WS wording, frozen)", () => {
  it("buildReasoningPrompt", () => {
    expect(buildReasoningPrompt(makeState(), tools, lastEval, 5)).toMatchSnapshot()
  })
  it("buildReasoningPrompt with no history/eval", () => {
    const state = makeState()
    state.toolCallHistory = []
    state.iterationCount = 0
    expect(buildReasoningPrompt(state, tools, null, 5)).toMatchSnapshot()
  })
  it("buildDraftPrompt", () => {
    expect(buildDraftPrompt(makeState())).toMatchSnapshot()
  })
  it("buildSynthesisPrompt", () => {
    expect(buildSynthesisPrompt(makeState())).toMatchSnapshot()
  })
})
