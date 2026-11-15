import crypto from "crypto"
import type { HybridSearchService } from "./hybrid.search.service"
import type { GenerationService } from "./generation.service"
import type { AgentResult } from "../types/agent.types"
import { AgentEngine } from "../agents/engine/agent-engine"

export class AgentService {
  private readonly engine: AgentEngine

  constructor(
    apiKey: string,
    hybridSearchService: HybridSearchService,
    generationService: GenerationService
  ) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error("AgentService requires a Gemini API key")
    }
    this.engine = new AgentEngine(apiKey, hybridSearchService, generationService)
  }

  async run(userQuery: string, userId: string, signal?: AbortSignal): Promise<AgentResult> {
    return this.engine.run({
      query: userQuery,
      userId,
      sessionId: crypto.randomUUID(),
      signal,
    })
  }
}
