// backend/src/services/rag.service.ts
// The top-level orchestrator that combines ALL previous services
// into one complete RAG pipeline call.
//
// FULL PIPELINE:
//   User question (string)
//     ↓
//   HybridSearchService.search()   → retrieves relevant chunks
//     ↓
//   GenerationService.generate()   → produces grounded answer
//     ↓
//   RagResult { answer, citations, metadata }
//
// WHY A SEPARATE RagService?
// Controllers should not wire services together — that is orchestration logic.
// RagService is the single place where retrieval + generation are combined.
// Testing: inject mock HybridSearchService + mock GenerationService.
// Swapping generation model: change GenerationService only, RagService unchanged.

import type { HybridSearchService } from "./hybrid.search.service"
import type { GenerationService } from "./generation.service"
import type { Citation } from "../types/retrieval.types"
import { logRagEvent, logError } from "../utils/logger"

// ── Result Types ──────────────────────────────────────────────────────────

export interface RagResult {
  answer: string
  citations: Citation[]
  chunksRetrieved: number // how many chunks were found
  chunksUsed: number // how many were sent to the LLM (top-K)
  tokensUsed: number
  model: string
  durationMs: number
  retrievalMs: number // time spent in hybrid search
  generationMs: number // time spent in Gemini generation
}

export interface RagOptions {
  topK: number // how many chunks to retrieve (default: 10)
  minSimilarity: number // minimum similarity threshold (default: 0.0)
  userId?: string // restrict to this user's documents
  documentIds?: string[] // restrict to these specific documents
}

const DEFAULT_RAG_OPTIONS: RagOptions = {
  topK: 10,
  minSimilarity: 0.0,
}

export class RagService {
  constructor(
    private readonly hybridSearchService: HybridSearchService,
    private readonly generationService: GenerationService
  ) {}

  // ── query ─────────────────────────────────────────────────────────────
  // The single public method — the complete RAG pipeline in one call.
  async query(userQuery: string, options: Partial<RagOptions> = {}): Promise<RagResult> {
    const opts = { ...DEFAULT_RAG_OPTIONS, ...options }
    const start = Date.now()

    logRagEvent("retrieve", "RAG pipeline started", {
      service: "RagService",
      userId: opts.userId,
    })

    // ── Step 1: Retrieve relevant chunks ──────────────────────────────
    const retrievalStart = Date.now()
    let retrievedChunks

    try {
      retrievedChunks = await this.hybridSearchService.search(userQuery, {
        topK: opts.topK,
        minSimilarity: opts.minSimilarity,
        userId: opts.userId,
        documentIds: opts.documentIds,
      })
    } catch (error: unknown) {
      logError("RAG pipeline failed at retrieval step", error, {
        service: "RagService",
      })
      throw error
    }

    const retrievalMs = Date.now() - retrievalStart

    logRagEvent("retrieve", "Retrieval complete", {
      service: "RagService",
      chunkCount: retrievedChunks.length,
      durationMs: retrievalMs,
    })

    // ── Step 2: Handle zero-retrieval case ────────────────────────────
    // If no chunks were found above the similarity threshold,
    // do NOT call Gemini with an empty context — that leads to hallucination.
    // Instead, return a clean "I don't have information" response.
    if (retrievedChunks.length === 0) {
      const fallback = await this.generationService.generateWithFallback(userQuery)

      return {
        answer: fallback.answer,
        citations: [],
        chunksRetrieved: 0,
        chunksUsed: 0,
        tokensUsed: 0,
        model: fallback.model,
        durationMs: Date.now() - start,
        retrievalMs,
        generationMs: fallback.durationMs,
      }
    }

    // ── Step 3: Generate grounded answer ──────────────────────────────
    const generationStart = Date.now()
    let generationResult

    try {
      generationResult = await this.generationService.generate(userQuery, retrievedChunks)
    } catch (error: unknown) {
      logError("RAG pipeline failed at generation step", error, {
        service: "RagService",
        chunkCount: retrievedChunks.length,
      })
      throw error
    }

    const generationMs = Date.now() - generationStart

    const durationMs = Date.now() - start

    logRagEvent("generate", "RAG pipeline complete", {
      service: "RagService",
      chunkCount: retrievedChunks.length,
      tokenCount: generationResult.tokensUsed,
      durationMs,
    })

    return {
      answer: generationResult.answer,
      citations: generationResult.citations,
      chunksRetrieved: retrievedChunks.length,
      chunksUsed: generationResult.citations.length,
      tokensUsed: generationResult.tokensUsed,
      model: generationResult.model,
      durationMs,
      retrievalMs,
      generationMs,
    }
  }
}
