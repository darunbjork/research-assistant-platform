// backend/src/agents/tools/rag.tool.ts
// The RAG search tool — lets the agent search through user documents.
// This is the most-used tool: the agent calls it whenever it needs
// information from the user's uploaded documents.
//
// The tool wraps HybridSearchService and formats the results
// as a plain text string that the LLM can read in the next iteration.
// The LLM cannot read HybridSearchResult[] — it reads strings.

import type { HybridSearchService } from "../../services/hybrid.search.service"
import type { AgentTool } from "../../types/agent.types"
import type { HybridSearchResult } from "../../types/retrieval.types"
import { logRagEvent } from "../../utils/logger"

// Formats search results as a readable string for the LLM
function formatResultsForLLM(results: HybridSearchResult[]): string {
  if (results.length === 0) {
    return "No relevant chunks found for this query. Try rephrasing or use a different search term."
  }

  return results
    .map((result, index) => {
      const score = result.rrfScore.toFixed(4)
      const source = result.chunk.source
      const page = result.chunk.pageNumber !== null ? `, page ${result.chunk.pageNumber}` : ""

      return `[Result ${index + 1}] (source: ${source}${page}, relevance: ${score})\n${result.chunk.content}`
    })
    .join("\n\n---\n\n")
}

export function createRagTool(hybridSearchService: HybridSearchService, userId: string): AgentTool {
  return {
    name: "rag_search",

    // This description is read by the LLM to decide when to use this tool.
    // It must be clear about what the tool does AND does not do.
    description:
      "Search through the user's uploaded documents using semantic + keyword hybrid search. " +
      "Use this tool when you need information from the user's documents. " +
      "Input: { query: 'your search query' }. " +
      "Returns: relevant document chunks with source citations.",

    execute: async (input: Record<string, string>): Promise<string> => {
      const query = input["query"]

      if (!query || query.trim() === "") {
        return "Error: rag_search requires a 'query' parameter."
      }

      const start = Date.now()

      try {
        const results = await hybridSearchService.search(query.trim(), {
          topK: 5,
          userId,
        })

        logRagEvent("retrieve", "RAG tool executed", {
          service: "RagTool",
          chunkCount: results.length,
          durationMs: Date.now() - start,
        })

        return formatResultsForLLM(results)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error"
        return `Error searching documents: ${msg}. The document search service may be unavailable.`
      }
    },
  }
}
