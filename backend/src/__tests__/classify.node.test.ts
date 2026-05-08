// backend/src/__tests__/classify.node.test.ts

import { classifyQuery } from "../agents/nodes/classify.node"

describe("classifyQuery()", () => {
  describe("math queries", () => {
    it("classifies 'calculate' queries as math", () => {
      expect(classifyQuery("Calculate the total revenue")).toBe("math")
    })

    it("classifies percentage queries as math", () => {
      expect(classifyQuery("What is the percentage growth?")).toBe("math")
    })

    it("classifies 'how much' as math", () => {
      expect(classifyQuery("How much did revenue increase?")).toBe("math")
    })
  })

  describe("web search queries", () => {
    it("classifies 'latest' queries as web_search", () => {
      expect(classifyQuery("What is the latest news on AI?")).toBe("web_search")
    })

    it("classifies 'today' queries as web_search", () => {
      expect(classifyQuery("What happened today in tech?")).toBe("web_search")
    })

    it("classifies 'current' as web_search", () => {
      expect(classifyQuery("What is the current stock price?")).toBe("web_search")
    })
  })

  describe("rag_search queries", () => {
    it("classifies 'what does' as rag_search", () => {
      expect(classifyQuery("What does the report say?")).toBe("rag_search")
    })

    it("classifies 'summarize' as rag_search", () => {
      expect(classifyQuery("Summarize the uploaded document")).toBe("rag_search")
    })

    it("classifies 'according to' as rag_search", () => {
      expect(classifyQuery("According to the file, what are the risks?")).toBe("rag_search")
    })
  })

  describe("default behaviour", () => {
    it("defaults to rag_search for ambiguous queries", () => {
      expect(classifyQuery("Tell me something interesting")).toBe("rag_search")
    })

    it("handles empty string without crashing", () => {
      expect(() => classifyQuery("")).not.toThrow()
    })
  })
})
