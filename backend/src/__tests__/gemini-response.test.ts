import { geminiText } from "../utils/gemini-response"
import type { GeminiResponse } from "../types/llm.types"

function response(parts: Array<{ text: string }>, finishReason = "STOP"): GeminiResponse {
  return { candidates: [{ content: { parts }, finishReason }] } as GeminiResponse
}

it("joins all answer parts", () => {
  expect(geminiText(response([{ text: "First " }, { text: "second" }]))).toBe("First second")
})

it("rejects truncated JSON instead of treating it as DONE", () => {
  expect(() => geminiText(response([{ text: '{"toolName":' }], "MAX_TOKENS"))).toThrow("truncated")
})

it("rejects empty candidate lists and whitespace answers", () => {
  expect(() => geminiText({ candidates: [] } as unknown as GeminiResponse)).toThrow("no answer")
  expect(() => geminiText(response([{ text: "  " }]))).toThrow("no answer")
})
