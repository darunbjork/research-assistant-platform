// backend/src/agents/tools/index.ts
// The tool registry — maps tool names to tool implementations.
// The agent looks up tools here by the name returned by the LLM's decision.
//
// ADDING A NEW TOOL:
// 1. Create the tool file in src/agents/tools/
// 2. Export a create*Tool() factory function
// 3. Add it to createToolRegistry() below
// The agent automatically has access to it on the next iteration.

import type { HybridSearchService } from "../../services/hybrid.search.service"
import type { AgentTool } from "../../types/agent.types"
import { createRagTool } from "./rag.tool"
import { createCalculatorTool } from "./calculator.tool"

// The registry maps tool name → tool implementation
export type ToolRegistry = Record<string, AgentTool>

// Creates the full tool registry for one agent session.
// We pass userId so the RAG tool can restrict search to that user's documents.
export function createToolRegistry(
  hybridSearchService: HybridSearchService,
  userId: string
): ToolRegistry {
  const ragTool = createRagTool(hybridSearchService, userId)
  const calculatorTool = createCalculatorTool()

  return {
    [ragTool.name]: ragTool,
    [calculatorTool.name]: calculatorTool,
  }
}

// Formats the tool registry as a description string for the LLM.
// This is injected into the ReAct prompt so the LLM knows what tools exist.
export function formatToolDescriptions(registry: ToolRegistry): string {
  return Object.values(registry)
    .map(tool => `- ${tool.name}: ${tool.description}`)
    .join("\n")
}
