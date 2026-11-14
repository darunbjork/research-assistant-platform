import { createRagTool } from "../agents/tools/rag.tool"
import type { HybridSearchService } from "../services/hybrid.search.service"

it("propagates search failures so the agent records a failed tool call", async () => {
  const failure = new Error("Search backend unavailable")
  const search = jest.fn().mockRejectedValue(failure)
  const tool = createRagTool({ search } as unknown as HybridSearchService, "user-1")
  await expect(tool.execute({ query: " evidence " })).rejects.toBe(failure)
  expect(search).toHaveBeenCalledWith("evidence", { topK: 5, userId: "user-1" })
})

it("rejects a missing query before searching", async () => {
  const search = jest.fn()
  const tool = createRagTool({ search } as unknown as HybridSearchService, "user-1")
  await expect(tool.execute({ query: " " })).rejects.toThrow("requires a 'query'")
  expect(search).not.toHaveBeenCalled()
})

it("keeps an empty search result distinct from an infrastructure failure", async () => {
  const search = jest.fn().mockResolvedValue([])
  const tool = createRagTool({ search } as unknown as HybridSearchService, "user-1")
  await expect(tool.execute({ query: "missing fact" })).resolves.toContain("No relevant chunks")
})
