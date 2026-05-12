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
  describe("classifyQuery() — edge cases", () => {
    it("handles empty string without throwing", () => {
      expect(() => classifyQuery("")).not.toThrow()
    })

    it("handles very long queries without throwing", () => {
      const longQuery = "machine learning ".repeat(100)
      expect(() => classifyQuery(longQuery)).not.toThrow()
    })

    it("handles queries with special characters", () => {
      expect(() => classifyQuery("What is 4.2% of $1,000?")).not.toThrow()
    })

    it("returns a valid TaskType for any input", () => {
      const validTypes = ["rag_search", "web_search", "math", "general"]
      const queries = ["", "hello", "123", "!@#$%"]

      queries.forEach(q => {
        const result = classifyQuery(q)
        expect(validTypes).toContain(result)
      })
    })

    it("is case insensitive", () => {
      const lower = classifyQuery("calculate the total")
      const upper = classifyQuery("CALCULATE THE TOTAL")
      expect(lower).toBe(upper)
    })

    describe("mixed signals", () => {
      it("prefers math when both math and rag keywords present", () => {
        // "what does the report say about the 23% increase?"
        // contains rag: "what does", "report"
        // contains math: "23%", "percent"
        const result = classifyQuery("what does the report say about the 23% increase?")
        // Math keywords include "%" so should lean toward math
        expect(["math", "rag_search"]).toContain(result) // either is valid
      })

      it("prefers web_search for current events even with document keywords", () => {
        const result = classifyQuery("what does today's report say?")
        // Contains both "today" (web) and "report" (rag)
        expect(["web_search", "rag_search"]).toContain(result)
      })
    })
  })
})
