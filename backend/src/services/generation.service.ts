// backend/src/services/generation.service.ts
// Builds a grounded prompt from retrieved chunks and calls the Gemini
// generation API to produce a cited answer.
//
// THIS IS THE "G" IN RAG — RETRIEVAL-AUGMENTED GENERATION.
// The first two letters (RA) were Days 6-10.
// Today is the G.
//
// WHAT THIS SERVICE DOES:
//   1. Takes retrieved chunks (HybridSearchResult[]) + the user's question
//   2. Formats the chunks into a numbered context block
//   3. Wraps that context in a carefully engineered system prompt
//   4. Calls Gemini gemini-2.0-flash with temperature=0.1
//   5. Returns the answer text + citation objects
//
// WHAT IT DOES NOT DO:
//   - It does not retrieve chunks (HybridSearchService does that)
//   - It does not embed anything (EmbeddingService does that)
//   - It does not store anything
//   - It is a pure: (chunks + question) → (answer + citations) function

import type { GeminiRequest, GeminiResponse } from "../types/llm.types"
import type { HybridSearchResult, Citation } from "../types/retrieval.types"
import { logRagEvent, logError } from "../utils/logger"
import { generationRequests, generationLatency, tokenCost } from "../utils/metrics"

// ── Constants ─────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

// ── Result Types ──────────────────────────────────────────────────────────

export interface GenerationResult {
  answer: string // the LLM's grounded response
  citations: Citation[] // the chunks used to produce the answer
  tokensUsed: number // total tokens consumed (prompt + response)
  model: string // which model was used
  durationMs: number // total generation time
}

// Configuration knobs — reasonable defaults for a RAG system
export interface GenerationConfig {
  temperature: number // 0-1, lower = more deterministic
  topP: number // nucleus sampling threshold
  maxOutputTokens: number // cap on response length
  botName: string // persona name shown to the user
  maxContextChunks: number // max chunks to include in the prompt
}

const DEFAULT_CONFIG: GenerationConfig = {
  temperature: 0.1, // low for grounded, factual answers
  topP: 0.8,
  maxOutputTokens: 1024, // enough for a thorough paragraph answer
  botName: "ResearchBot",
  maxContextChunks: 5, // include top-5 chunks in the prompt
}

export class GenerationService {
  private readonly config: GenerationConfig

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

  // ── generate ──────────────────────────────────────────────────────────
  // Main entry point.
  // Takes the user's question + the retrieved chunks from HybridSearchService.
  // Returns a grounded answer with citations.
  async generate(
    userQuery: string,
    retrievedChunks: HybridSearchResult[]
  ): Promise<GenerationResult> {
    const start = Date.now()

    if (!userQuery || userQuery.trim() === "") {
      throw new Error("User query cannot be empty")
    }

    // ── Step 1: Select top chunks ─────────────────────────────────────
    // We do not always include ALL retrieved chunks.
    // More context = more tokens = higher cost + slower generation.
    // The top-5 chunks (already ranked by RRF) are usually enough.
    const topChunks = retrievedChunks.slice(0, this.config.maxContextChunks)

    // ── Step 2: Build the context block ──────────────────────────────
    // Format chunks as a numbered list so the LLM can reference them:
    // [Source 1] (from: Q3-Report.txt)
    // The actual chunk text here...
    //
    // [Source 2] (from: Q3-Report.txt)
    // The next chunk text...
    const contextBlock = this.buildContextBlock(topChunks)

    // ── Step 3: Build the grounded system prompt ──────────────────────
    // THE MOST IMPORTANT FUNCTION IN THE ENTIRE APPLICATION.
    // This is what forces the LLM to use the retrieved context
    // instead of answering from its training data.
    const systemPrompt = this.buildSystemPrompt(contextBlock)

    // ── Step 4: Call Gemini ───────────────────────────────────────────
    const timer = generationLatency.startTimer()
    generationRequests.inc({ status: "pending" })

    let geminiResponse: GeminiResponse

    try {
      geminiResponse = await this.callGemini(systemPrompt, userQuery)
      generationRequests.inc({ status: "success" })
    } catch (error: unknown) {
      generationRequests.inc({ status: "error" })
      logError("Gemini generation API call failed", error, {
        service: "GenerationService",
      })
      throw error
    } finally {
      timer()
    }

    // ── Step 5: Extract answer and token usage ────────────────────────
    const firstCandidate = geminiResponse.candidates[0]

    if (firstCandidate === undefined) {
      throw new Error("Gemini returned no candidates — the response was empty")
    }

    const firstPart = firstCandidate.content.parts[0]

    if (firstPart === undefined) {
      throw new Error("Gemini candidate contained no content parts")
    }

    const answer = firstPart.text
    const tokensUsed = geminiResponse.usageMetadata.totalTokenCount

    // Track token cost in Prometheus
    tokenCost.inc({ operation: "generation" }, tokensUsed)

    // ── Step 6: Build citations ────────────────────────────────────────
    // One citation per chunk used in the context.
    // The frontend uses these to show "Source: Q3-Report.txt, page 3"
    // next to the answer.
    const citations = this.buildCitations(topChunks)

    const durationMs = Date.now() - start

    logRagEvent("generate", "Generation complete", {
      service: "GenerationService",
      chunkCount: topChunks.length,
      tokenCount: tokensUsed,
      durationMs,
    })

    return {
      answer,
      citations,
      tokensUsed,
      model: GEMINI_MODEL,
      durationMs,
    }
  }

  // ── generateWithFallback ──────────────────────────────────────────────
  // Called when retrieval returns NO chunks.
  // Instead of sending an empty context (which leads to hallucination),
  // returns a clean "I don't have information about this" response.
  // This is a deliberate design decision: silence > hallucination.
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
      tokensUsed: 0, // no API call made — zero cost
      model: GEMINI_MODEL,
      durationMs: Date.now() - start,
    }
  }

  // ── buildSystemPrompt ─────────────────────────────────────────────────
  // THE ANTI-HALLUCINATION GUARDRAIL.
  // Read every line carefully — each one exists for a reason.
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
  // Formats retrieved chunks into a numbered context block.
  // The numbers let the LLM reference specific sources ([Source 1]).
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
  // Converts HybridSearchResult[] to Citation[] for the frontend.
  // Each citation contains: document name, page number, excerpt, score.
  private buildCitations(chunks: HybridSearchResult[]): Citation[] {
    return chunks.map((result, _index) => ({
      chunkId: result.chunk.id,
      documentId: result.chunk.documentId,
      documentName: result.chunk.source,
      pageNumber: result.chunk.pageNumber ?? undefined,
      // The excerpt is what appears in the citation card in the UI.
      // It is the first 200 characters of the chunk content.
      excerpt:
        result.chunk.content.slice(0, 200) + (result.chunk.content.length > 200 ? "..." : ""),
      relevanceScore: result.rrfScore,
    }))
  }

  // ── callGemini ────────────────────────────────────────────────────────
  // Makes the HTTP request to the Gemini generateContent API.
  private async callGemini(systemPrompt: string, userQuery: string): Promise<GeminiResponse> {
    const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`

    const requestBody: GeminiRequest = {
      // systemInstruction sets the persona and rules for the ENTIRE conversation.
      // It is separate from the user message — the model treats it as authoritative.
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

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      let errorMessage = `Gemini generation API error: ${response.status} ${response.statusText}`

      try {
        const errorBody = (await response.json()) as { error?: { message?: string } }
        if (errorBody.error?.message) {
          errorMessage += ` — ${errorBody.error.message}`
        }
      } catch {
        // Could not parse error body — use status code message
      }

      throw new Error(errorMessage)
    }

    return response.json() as Promise<GeminiResponse>
  }

  // ── estimatePromptTokens ──────────────────────────────────────────────
  // Estimates how many tokens the prompt will consume BEFORE calling the API.
  // Use this to detect when the context is too large and would exceed limits.
  // Rule of thumb: 4 chars ≈ 1 token.
  estimatePromptTokens(userQuery: string, chunks: HybridSearchResult[]): number {
    const systemPrompt = this.buildSystemPrompt(this.buildContextBlock(chunks))
    const fullPrompt = systemPrompt + userQuery

    return Math.ceil(fullPrompt.length / 4)
  }
}
