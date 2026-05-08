// backend/src/__tests__/calculator.tool.test.ts
// Unit tests for the calculator tool — pure logic, no mocks needed.

import { createCalculatorTool } from "../agents/tools/calculator.tool"

describe("CalculatorTool", () => {
  const tool = createCalculatorTool()

  it("has the correct name", () => {
    expect(tool.name).toBe("calculator")
  })

  it("evaluates simple addition", async () => {
    const result = await tool.execute({ expression: "2 + 2" })
    expect(result).toBe("4")
  })

  it("evaluates subtraction", async () => {
    const result = await tool.execute({ expression: "10 - 3.5" })
    expect(result).toBe("6.5")
  })

  it("evaluates multiplication", async () => {
    const result = await tool.execute({ expression: "4 * 5" })
    expect(result).toBe("20")
  })

  it("evaluates division", async () => {
    const result = await tool.execute({ expression: "15 / 4" })
    expect(result).toBe("3.75")
  })

  it("evaluates parenthesised expressions", async () => {
    const result = await tool.execute({ expression: "(4.2 + 5.1) / 2" })
    expect(result).toBe("4.65")
  })

  it("handles percentage in expression", async () => {
    const result = await tool.execute({ expression: "100 * 21%" })
    expect(result).toBe("21")
  })

  it("calculates percentage growth correctly", async () => {
    // (5.1 - 4.2) / 4.2 * 100 = 21.428...%
    const result = await tool.execute({ expression: "(5.1 - 4.2) / 4.2 * 100" })
    const num = parseFloat(result)
    expect(num).toBeCloseTo(21.428, 2)
  })

  it("returns error for empty expression", async () => {
    const result = await tool.execute({ expression: "" })
    expect(result).toContain("Error")
  })

  it("returns error for missing expression parameter", async () => {
    const result = await tool.execute({})
    expect(result).toContain("Error")
  })

  it("rejects unsafe characters", async () => {
    const result = await tool.execute({ expression: "process.exit(1)" })
    expect(result).toContain("Error")
    expect(result).toContain("unsafe")
  })

  it("rejects variable names", async () => {
    const result = await tool.execute({ expression: "x + 1" })
    expect(result).toContain("Error")
  })

  it("handles very large numbers", async () => {
    const result = await tool.execute({ expression: "1000000 * 1000000" })
    expect(result).toBe("1000000000000")
  })

  it("returns integer result without decimal when appropriate", async () => {
    const result = await tool.execute({ expression: "10 / 2" })
    expect(result).toBe("5")
  })
})
