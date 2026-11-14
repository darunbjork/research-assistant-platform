import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import AgentSteps from "./AgentSteps"

afterEach(cleanup)

it("expands quality, completion, and unknown tool steps without crashing", () => {
  const step = { stepNumber: 1, durationMs: 25, timestamp: new Date().toISOString() }
  render(<AgentSteps iterationCount={2} totalDurationMs={1200} steps={[
    { ...step, description: "Quality check: 54%" },
    { ...step, description: "Search completed; evidence may be incomplete" },
    { ...step, description: "Future tool", toolUsed: "future_tool" }
  ]} />)
  fireEvent.click(screen.getByRole("button"))
  expect(screen.getByText("Search completed; evidence may be incomplete")).toBeTruthy()
  expect(screen.getByText("Future tool")).toBeTruthy()
  expect(screen.getByText("3.")).toBeTruthy()
})
