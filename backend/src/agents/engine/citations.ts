import type { Citation } from "../../types/retrieval.types"
import type { ToolCall } from "../../types/agent.types"

export function extractCitationsFromHistory(toolCalls: ToolCall[]): Citation[] {
  const citations: Citation[] = []

  toolCalls
    .filter(tc => tc.toolName === "rag_search" && tc.success)
    .forEach(tc => {
      const pattern =
        /\[Result \d+\] \(source: ([^,)]+)(?:, page (\d+))?, relevance: ([\d.]+)\)\n([\s\S]*?)(?=---|\[Result|$)/g

      let match = pattern.exec(tc.output)
      while (match !== null) {
        const [, sourceName, pageStr, scoreStr, content] = match
        if (sourceName && content) {
          citations.push({
            chunkId: `agent-${Date.now()}-${citations.length}`,
            documentId: "agent-retrieved",
            documentName: sourceName.trim(),
            pageNumber: pageStr ? parseInt(pageStr, 10) : undefined,
            excerpt: content.trim().slice(0, 200),
            relevanceScore: parseFloat(scoreStr ?? "0"),
          })
        }
        match = pattern.exec(tc.output)
      }
    })

  return citations
}
