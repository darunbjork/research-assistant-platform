import type { GeminiResponse } from "../types/llm.types"

/** Empty or truncated model output is a failed call, never a successful answer. */
export function geminiText(response: GeminiResponse): string {
  const candidate = response.candidates?.[0]
  const text =
    candidate?.content?.parts
      ?.map(part => part.text ?? "")
      .join("")
      .trim() ?? ""
  if (!text || candidate?.finishReason === "MAX_TOKENS") {
    throw new Error(
      `Gemini returned ${candidate?.finishReason === "MAX_TOKENS" ? "a truncated response" : "no answer"}. Please try again.`
    )
  }
  return text
}
