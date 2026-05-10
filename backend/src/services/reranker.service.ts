// backend/src/services/reranker.service.ts
// Cross-encoder reranker — rescores hybrid search results by jointly
// reading the query and each chunk together.
//
// WHY LLM-BASED RERANKING:
// Dedicated cross-encoder models (Cohere Rerank, BGE Reranker v2)
// are more accurate but require an additional API subscription and
// add latency from a separate API call to a different provider.
//
// LLM-based reranking uses Gemini — infrastructure you already have.
// Accuracy is 85-90% of dedicated cross-encoders for most document types.
// For production at scale: swap this implementation for Cohere/BGE without
// changing the interface — just update the scoring method.
//
// TWO RERANKING MODES:
//
// 1. POINTWISE (default, simpler):
//    Score each (query, chunk) pair independently: 0-10
//    Pros: easy to understand, predictable
//    Cons: scores across chunks are not calibrated to each other
//
// 2. LISTWISE (advanced, more accurate):
//    Ask LLM to rank ALL chunks simultaneously: "rank these 1-N"
//    Pros: LLM considers all chunks together, better relative ordering
//    Cons: more complex prompt, fails if LLM returns garbled ranking
//
// We implement BOTH and default to pointwise for reliability.

import type {
  HybridSearchResult,
  RerankedResult,
  RerankerOptions,
  RerankComparison,
} from "../types/retrieval.types"
import type { GeminiRequest, GeminiResponse } from "../types/llm.types"
import { logRagEvent, logError } from "../utils/logger"
import { retrievalLatency } from "../utils/metrics"

// ── Constants ─────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

const DEFAULT_OPTIONS: RerankerOptions = {
  topK: 5, // return top-5 after reranking (from top-10 retrieved)
  minRerankScore: 0.0,
  batchSize: 10,
}

export class RerankerService {
  constructor(private readonly apiKey: string) {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error("RerankerService requires a Gemini API key")
    }
  }

  // ── rerank ────────────────────────────────────────────────────────────
  // Main entry point.
  // Takes hybrid search results and returns them reranked by cross-encoder score.
  async rerank(
    query: string,
    chunks: HybridSearchResult[],
    options: Partial<RerankerOptions> = {}
  ): Promise<RerankedResult[]> {
    if (chunks.length === 0) return []
    if (chunks.length === 1) {
      // Single chunk — no reranking needed
      return this.toRerankedResults(chunks, [1.0])
    }

    const opts = { ...DEFAULT_OPTIONS, ...options }
    const timer = retrievalLatency.startTimer()
    const start = Date.now()

    let scores: number[]

    try {
      // Use pointwise scoring by default — more reliable than listwise
      scores = await this.scorePointwise(query, chunks)
    } catch (error: unknown) {
      logError("Reranking failed — returning original order", error, {
        service: "RerankerService",
      })
      // Graceful degradation: return original order with neutral scores
      scores = chunks.map(() => 0.5)
    }

    // Build reranked results with original and new ranks
    const reranked = this.toRerankedResults(chunks, scores)

    // Sort by rerankScore descending and apply topK
    const sorted = reranked
      .filter(r => r.rerankScore >= opts.minRerankScore)
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, opts.topK)
      .map((result, newRank) => ({ ...result, rerankedRank: newRank }))

    timer()

    logRagEvent("rerank", "Reranking complete", {
      service: "RerankerService",
      chunkCount: sorted.length,
      durationMs: Date.now() - start,
    })

    return sorted
  }

  // ── rerankHybrid ──────────────────────────────────────────────────────
  // Convenience method: takes HybridSearchResult[] directly.
  // Used by HybridSearchService and IngestionService.
  async rerankHybrid(
    query: string,
    results: HybridSearchResult[],
    topK: number = DEFAULT_OPTIONS.topK
  ): Promise<RerankedResult[]> {
    return this.rerank(query, results, { topK })
  }

  // ── compare ───────────────────────────────────────────────────────────
  // Development utility: compare original vs reranked results.
  // Use this to measure reranking quality improvement on your documents.
  async compare(
    query: string,
    chunks: HybridSearchResult[],
    options: Partial<RerankerOptions> = {}
  ): Promise<RerankComparison> {
    const start = Date.now()
    const reranked = await this.rerank(query, chunks, options)

    // Count how many chunks moved up, down, or stayed the same
    let movedUp = 0
    let movedDown = 0
    let unchanged = 0

    reranked.forEach(result => {
      if (result.rerankedRank < result.originalRank) movedUp++
      else if (result.rerankedRank > result.originalRank) movedDown++
      else unchanged++
    })

    return {
      query,
      original: chunks,
      reranked,
      movedUp,
      movedDown,
      unchanged,
      durationMs: Date.now() - start,
    }
  }

  // ── Private: Pointwise Scoring ────────────────────────────────────────
  // Sends all chunks in one Gemini call.
  // Asks the LLM to score each (query, chunk) pair from 0-10.
  // Returns normalised scores in the same order as the input chunks.
  private async scorePointwise(query: string, chunks: HybridSearchResult[]): Promise<number[]> {
    // Build the prompt with all chunks numbered
    const chunksText = chunks
      .map(
        (result, i) =>
          `[Chunk ${i + 1}] (from: ${result.chunk.source})\n` +
          `${result.chunk.content.slice(0, 300)}`
      )
      .join("\n\n---\n\n")

    const prompt = `You are a relevance scoring system for a document retrieval pipeline.

QUERY:
"${query}"

CHUNKS TO SCORE:
${chunksText}

TASK:
Score each chunk's relevance to the query from 0 to 10.

SCORING RUBRIC:
0-2:  Not relevant — chunk is about a completely different topic
3-4:  Marginally relevant — chunk mentions the topic tangentially
5-6:  Somewhat relevant — chunk partially addresses the query
7-8:  Highly relevant — chunk directly addresses the query
9-10: Perfect match — chunk contains the exact answer to the query

RULES:
- Score based on how well the chunk answers the SPECIFIC query
- A chunk about "revenue" when the query asks about "risks" scores lower than
  a chunk about "revenue risks"
- Do not consider writing quality — only relevance to the query
- Every chunk must receive a score

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "scores": [
    {"chunkIndex": 1, "score": 8, "reason": "directly addresses..."},
    {"chunkIndex": 2, "score": 4, "reason": "only tangentially..."}
  ]
}`

    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1, // deterministic scoring
        topP: 1.0,
        maxOutputTokens: 512, // enough for N score entries
      },
    }

    const response = await this.callGemini(requestBody)
    const rawText = response.candidates[0]?.content.parts[0]?.text ?? ""

    return this.parsePointwiseScores(rawText, chunks.length)
  }

  // ── Private: Listwise Reranking ───────────────────────────────────────
  // Alternative to pointwise — asks LLM to rank ALL chunks simultaneously.
  // More accurate when chunks are similar to each other.
  // Not used by default (less reliable JSON parsing).
  async scoreListwise(query: string, chunks: HybridSearchResult[]): Promise<number[]> {
    const chunksText = chunks
      .map((result, i) => `[Chunk ${i + 1}]:\n${result.chunk.content.slice(0, 250)}`)
      .join("\n\n")

    const prompt = `Rank these chunks by relevance to the query, most relevant first.

QUERY: "${query}"

CHUNKS:
${chunksText}

Respond ONLY with valid JSON (chunk numbers in order of relevance, most relevant first):
{"ranking": [3, 1, 5, 2, 4]}`

    const requestBody: GeminiRequest = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0,
        topP: 1.0,
        maxOutputTokens: 128,
      },
    }

    const response = await this.callGemini(requestBody)
    const rawText = response.candidates[0]?.content.parts[0]?.text ?? ""

    return this.parseListwiseRanking(rawText, chunks.length)
  }

  // ── Private: Parse Pointwise Scores ──────────────────────────────────
  private parsePointwiseScores(rawText: string, expectedCount: number): number[] {
    const cleaned = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim()

    try {
      const parsed = JSON.parse(cleaned) as {
        scores?: Array<{ chunkIndex?: unknown; score?: unknown }>
      }

      if (!Array.isArray(parsed.scores)) {
        throw new Error("Expected scores array")
      }

      // Build a map from chunkIndex to score
      const scoreMap = new Map<number, number>()
      for (const entry of parsed.scores) {
        const idx = Number(entry.chunkIndex)
        const score = Number(entry.score)

        if (!isNaN(idx) && !isNaN(score)) {
          // Normalise from 0-10 to 0-1
          scoreMap.set(idx - 1, Math.max(0, Math.min(10, score)) / 10)
        }
      }

      // Return scores in original chunk order
      return Array.from(
        { length: expectedCount },
        (_, i) => scoreMap.get(i) ?? 0.5 // default 0.5 if chunk was not scored
      )
    } catch {
      logRagEvent("rerank", "Failed to parse pointwise scores — using neutral", {
        service: "RerankerService",
      })
      return Array(expectedCount).fill(0.5) as number[]
    }
  }

  // ── Private: Parse Listwise Ranking ──────────────────────────────────
  private parseListwiseRanking(rawText: string, count: number): number[] {
    const cleaned = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim()

    try {
      const parsed = JSON.parse(cleaned) as { ranking?: unknown[] }

      if (!Array.isArray(parsed.ranking)) {
        throw new Error("Expected ranking array")
      }

      // Convert ranking positions to scores
      // Rank 1 (index 0 in ranking) = highest score
      const scores = new Array<number>(count).fill(0.5)

      parsed.ranking.forEach((chunkNum, rankPosition) => {
        const chunkIndex = Number(chunkNum) - 1 // convert 1-based to 0-based
        if (chunkIndex >= 0 && chunkIndex < count) {
          // Score decreases linearly: rank 1 = 1.0, rank N = 1/N
          scores[chunkIndex] = 1 - rankPosition / count
        }
      })

      return scores
    } catch {
      return Array(count).fill(0.5) as number[]
    }
  }

  // ── Private: Build RerankedResult objects ─────────────────────────────
  private toRerankedResults(chunks: HybridSearchResult[], scores: number[]): RerankedResult[] {
    return chunks.map((chunk, originalRank) => ({
      chunk: chunk.chunk,
      vectorRank: chunk.vectorRank,
      keywordRank: chunk.keywordRank,
      rrfScore: chunk.rrfScore,
      rerankScore: scores[originalRank] ?? 0.5,
      originalRank,
      rerankedRank: originalRank, // will be updated after sorting
    }))
  }

  // ── Private: Call Gemini ──────────────────────────────────────────────
  private async callGemini(requestBody: GeminiRequest): Promise<GeminiResponse> {
    const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      let msg = `Gemini reranker API error: ${response.status} ${response.statusText}`
      try {
        const body = (await response.json()) as { error?: { message?: string } }
        if (body.error?.message) msg += ` — ${body.error.message}`
      } catch {
        /* ignore */
      }
      throw new Error(msg)
    }

    return response.json() as Promise<GeminiResponse>
  }
}
