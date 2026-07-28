// backend/src/services/generation.service.ts
// Updated Day 22: spans on Gemini generation calls.

import type { GeminiRequest, GeminiResponse } from "../types/llm.types"
import type { HybridSearchResult, Citation } from "../types/retrieval.types"
import { logRagEvent, logError } from "../utils/logger"
import { generationRequests, generationLatency, tokenCost } from "../utils/metrics"
import { getTracer } from "../telemetry/tracer"
import { withSpan, LLM_ATTRS, RAG_ATTRS } from "../telemetry/spans"
import { RateLimitError } from "../middleware/error.middleware"

// ── Constants ─────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

// ── Result Types ──────────────────────────────────────────────────────────

export interface GenerationResult {
  answer: string
  citations: Citation[]
  tokensUsed: number
  model: string
  durationMs: number
}

export interface GenerationConfig {
  temperature: number
  topP: number
  maxOutputTokens: number
  botName: string
  maxContextChunks: number
}

const DEFAULT_CONFIG: GenerationConfig = {
  temperature: 0.1,
  topP: 0.8,
  maxOutputTokens: 1024,
  botName: "ResearchBot",
  maxContextChunks: 5,
}

export class GenerationService {
  private readonly config: GenerationConfig
  private readonly tracer = getTracer("generation.service")

  constructor(
    private readonly apiKey: string,
    config: Partial<GenerationConfig> = {}
  ) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error(
        "GenerationService requires a Gemini API key. " + "Set GEMINI_API_KEY in your .env file."
      )
    }
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ── generate (with tracing) ────────────────────────────────────────────
  async generate(
    query: string,
    context: HybridSearchResult[],
    options: Partial<GenerationConfig> = {}
  ): Promise<GenerationResult> {
    return withSpan(this.tracer, "generation.generate", async span => {
      span.setAttribute(LLM_ATTRS.SYSTEM, "google_gemini")
      span.setAttribute(LLM_ATTRS.MODEL, GEMINI_MODEL)
      span.setAttribute(LLM_ATTRS.OPERATION, "chat")
      span.setAttribute(LLM_ATTRS.TEMPERATURE, options.temperature ?? 0.1)
      span.setAttribute(RAG_ATTRS.QUERY, query.slice(0, 200))
      span.setAttribute(RAG_ATTRS.CHUNKS_USED, context.length)

      const start = Date.now()

      const result = await this.callGeminiGenerate(query, context, options)

      span.setAttribute(LLM_ATTRS.TOTAL_TOKENS, result.tokensUsed)
      span.setAttribute(LLM_ATTRS.OUTPUT_TOKENS, Math.floor(result.tokensUsed * 0.3))
      span.setAttribute(LLM_ATTRS.INPUT_TOKENS, Math.ceil(result.tokensUsed * 0.7))
      span.setAttribute("generation.duration_ms", Date.now() - start)

      return result
    })
  }

  // ── callGeminiGenerate (wraps the existing callGemini) ──────────────────
  private async callGeminiGenerate(
    query: string,
    context: HybridSearchResult[],
    options: Partial<GenerationConfig>
  ): Promise<GenerationResult> {
    const start = Date.now()

    generationRequests.inc({ status: "success" })
    const timer = generationLatency.startTimer()

    const effectiveConfig = { ...this.config, ...options }
    const contextBlock = this.buildContextBlock(context.slice(0, effectiveConfig.maxContextChunks))
    const systemPrompt = this.buildSystemPrompt(contextBlock)

    const response = await this.callGemini(systemPrompt, query)

    timer()
    tokenCost.inc({ operation: "generation" }, response.usageMetadata?.totalTokenCount ?? 0)

    const answer =
      response.candidates?.[0]?.content?.parts?.[0]?.text ?? "(No response from Gemini)"

    logRagEvent("generate", "Generation complete", {
      service: "GenerationService",
      chunkCount: context.length,
      tokenCount: response.usageMetadata?.totalTokenCount,
      durationMs: Date.now() - start,
    })

    return {
      answer,
      citations: this.buildCitations(context),
      tokensUsed: response.usageMetadata?.totalTokenCount ?? 0,
      model: GEMINI_MODEL,
      durationMs: Date.now() - start,
    }
  }

  // ── generateWithFallback ──────────────────────────────────────────────
  async generateWithFallback(userQuery: string): Promise<GenerationResult> {
    const start = Date.now()

    logRagEvent("generate", "No chunks retrieved — using fallback response", {
      service: "GenerationService",
    })

    return {
      answer:
        `I don't have enough information in the provided documents to answer "${userQuery}". ` +
        `Please upload relevant documents first, or rephrase your question.`,
      citations: [],
      tokensUsed: 0,
      model: GEMINI_MODEL,
      durationMs: Date.now() - start,
    }
  }

  // ── buildSystemPrompt ─────────────────────────────────────────────────
  private buildSystemPrompt(contextBlock: string): string {
    return `You are ${this.config.botName}, a precise and trustworthy AI research assistant.

## YOUR ABSOLUTE RULES — FOLLOW THESE WITHOUT EXCEPTION:

RULE 1 — GROUNDING (most important):
Only answer using the RETRIEVED CONTEXT provided below.
Never use your training knowledge to answer questions.
If the retrieved context does not contain the answer, say:
"I don't have enough information in the provided documents to answer that."

RULE 2 — CITATIONS:
When you use information from a source, reference it as [Source N].
Example: "Revenue increased by 23% [Source 1]."
Include the citation immediately after the claim it supports.

RULE 3 — HONESTY:
If the context is ambiguous or contradictory, say so.
Never guess. Never extrapolate beyond what the context explicitly states.
"The document suggests..." is better than "The answer is..."

RULE 4 — CONCISENESS:
Answer directly and specifically.
Do not pad the response with preamble ("Great question!") or filler.
If the answer is one sentence, give one sentence.

## RETRIEVED CONTEXT:
${contextBlock}

## IMPORTANT:
The context above is ALL the information you have.
Your answer must be traceable to specific sources above.
Begin your answer now.`
  }

  // ── buildContextBlock ─────────────────────────────────────────────────
  private buildContextBlock(chunks: HybridSearchResult[]): string {
    if (chunks.length === 0) {
      return "(No context retrieved)"
    }

    return chunks
      .map((result, index) => {
        const sourceLabel = `[Source ${index + 1}]`
        const fromLabel =
          `(from: ${result.chunk.source}` +
          (result.chunk.pageNumber !== null ? `, page ${result.chunk.pageNumber}` : "") +
          `)`

        return `${sourceLabel} ${fromLabel}\n${result.chunk.content}`
      })
      .join("\n\n---\n\n")
  }

  // ── buildCitations ────────────────────────────────────────────────────
  private buildCitations(chunks: HybridSearchResult[]): Citation[] {
    return chunks.map((result, _index) => ({
      chunkId: result.chunk.id,
      documentId: result.chunk.documentId,
      documentName: result.chunk.source,
      pageNumber: result.chunk.pageNumber ?? undefined,
      excerpt:
        result.chunk.content.slice(0, 200) + (result.chunk.content.length > 200 ? "..." : ""),
      relevanceScore: result.rrfScore,
    }))
  }

  // ── callGemini ────────────────────────────────────────────────────────
  private async callGemini(systemPrompt: string, userQuery: string): Promise<GeminiResponse> {
    const maxRetries = 3
    let delay = 1000

    const requestBody: GeminiRequest = {
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userQuery }],
        },
      ],
      generationConfig: {
        temperature: this.config.temperature,
        topP: this.config.topP,
        maxOutputTokens: this.config.maxOutputTokens,
      },
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        })

        if (response.status === 429) {
          if (attempt === maxRetries) {
            throw new RateLimitError(`Gemini generation API error: 429 Too Many Requests (rate limit / quota exceeded)`)
          }
          logError(`Gemini API rate limited (429). Retrying in ${delay}ms...`, new Error("Rate limit"), {
            service: "GenerationService",
            attempt,
          })
          await new Promise(resolve => setTimeout(resolve, delay))
          delay *= 2 // Exponential backoff
          continue
        }

        if (!response.ok) {
          let errorMessage = `Gemini generation API error: ${response.status} ${response.statusText}`

          try {
            const errorBody = (await response.json()) as {
              error?: { message?: string }
            }
            if (errorBody.error?.message) {
              errorMessage += ` — ${errorBody.error.message}`
            }
          } catch {
            // Could not parse error body — use status code message
          }

          throw new Error(errorMessage)
        }

        return await (response.json() as Promise<GeminiResponse>)
      } catch (error) {
        if (attempt === maxRetries) {
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, delay))
        delay *= 2
      }
    }
    throw new Error("Failed to call Gemini API after maximum retries")
  }

  // ── estimatePromptTokens ──────────────────────────────────────────────
  estimatePromptTokens(userQuery: string, chunks: HybridSearchResult[]): number {
    const systemPrompt = this.buildSystemPrompt(this.buildContextBlock(chunks))
    const fullPrompt = systemPrompt + userQuery

    return Math.ceil(fullPrompt.length / 4)
  }
}
