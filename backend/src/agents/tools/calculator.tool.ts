// backend/src/agents/tools/calculator.tool.ts
// A safe math evaluator for the agent.
// The agent calls this when it needs to compute numbers
// (percentages, totals, comparisons) found in retrieved documents.
//
// SECURITY: We do NOT use eval() — it can execute arbitrary code.
// Instead, we use a whitelist approach: only allow digits and math operators.
// If the expression contains anything else, reject it.

import type { AgentTool } from "../../types/agent.types"

// Whitelist of allowed characters in math expressions.
// Only: digits, decimal points, operators, parentheses, spaces, %
const SAFE_MATH_PATTERN = /^[0-9+\-*/().% \t]+$/

// Evaluate a math expression safely.
// Returns the numeric result or an error message.
function evaluateSafeMath(expression: string): string {
  const cleaned = expression.trim()

  if (!SAFE_MATH_PATTERN.test(cleaned)) {
    return `Error: Expression contains unsafe characters. Only use: numbers, +, -, *, /, (, ), ., %`
  }

  if (cleaned.length === 0) {
    return "Error: Expression cannot be empty."
  }

  // Handle percentage: "21%" → "0.21"
  const withPercentage = cleaned.replace(/(\d+(?:\.\d+)?)%/g, "($1/100)")

  try {
    // Function constructor is safer than eval() —
    // it runs in strict mode and cannot access outer scope variables
    const result = new Function(`"use strict"; return (${withPercentage})`)() as unknown

    if (typeof result !== "number" || !Number.isFinite(result)) {
      return "Error: Expression did not produce a valid finite number."
    }

    // Format the result clearly
    if (Number.isInteger(result)) {
      return `${result}`
    }

    // Round to 6 decimal places to avoid floating-point noise
    return `${parseFloat(result.toFixed(6))}`
  } catch {
    return `Error: Could not evaluate "${cleaned}". Check the expression syntax.`
  }
}

export function createCalculatorTool(): AgentTool {
  return {
    name: "calculator",

    description:
      "Evaluate safe mathematical expressions. " +
      "Use this tool when you need to compute numbers: percentages, totals, ratios, growth rates. " +
      "Input: { expression: '(5.1 - 4.2) / 4.2 * 100' }. " +
      "Supports: +, -, *, /, (, ), %, decimal numbers. " +
      "Returns: the numeric result as a string.",

    execute: async (input: Record<string, string>): Promise<string> => {
      const expression = input["expression"]

      if (!expression || expression.trim() === "") {
        return "Error: calculator requires an 'expression' parameter."
      }

      return evaluateSafeMath(expression)
    },
  }
}
