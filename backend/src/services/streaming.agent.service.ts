import type { HybridSearchService } from "./hybrid.search.service"
import type { GenerationService } from "./generation.service"
import type { AgentResult } from "../types/agent.types"
import { AgentEngine } from "../agents/engine/agent-engine"
import type { AgentEventCallback } from "../agents/engine/types"

export type { AgentEventCallback } from "../agents/engine/types"

export class StreamingAgentService {
  private readonly engine: AgentEngine

  constructor(
    apiKey: string,
    hybridSearchService: HybridSearchService,
    generationService: GenerationService
  ) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error("StreamingAgentService requires a Gemini API key")
    }
    this.engine = new AgentEngine(apiKey, hybridSearchService, generationService)
  }

  async run(
    userQuery: string,
    userId: string,
    sessionId: string,
    onEvent: AgentEventCallback,
    signal?: AbortSignal
  ): Promise<AgentResult> {
    return this.engine.run({
      query: userQuery,
      userId,
      sessionId,
      onEvent,
      signal,
      transport: "ws",
    })
  }
}
