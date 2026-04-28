// * Responsible for splitting raw document text into retrieval-optimised chunks.
//
// TODO: WHY THIS IS ITS OWN SERVICE:
// * Chunking strategy is the #1 tuning knob in RAG quality.
// TODO: Isolating it means you can:
//   - Switch strategies without touching retrieval or generation code
//   - A/B test: "does sentence chunking give better answers than fixed?"
//   - Profile which strategy works best for which document type
//     (PDFs → recursive, chat logs → sentence, code → fixed)
//
// WHAT THIS SERVICE DOES NOT DO:
//   - It does not call any external APIs (no Gemini, no database)
//   - It does not store anything
//   - It only transforms text → RawChunk[]
// Pure input/output function. Easy to test. Easy to replace.

import type {
  RawChunk,
  ChunkingStrategy,
  FixedChunkConfig,
  SentenceChunkConfig,
  RecursiveChunkConfig,
} from "../types/document.types"
import { logRagEvent } from "../utils/logger"

// ── Default Configuration Constants ──────────────────────────────────────
// These defaults are tuned for general-purpose English text Q&A.
// Research papers, legal documents, and code may need different values.
const DEFAULTS = {
  FIXED_CHUNK_SIZE: 512, // characters — ~128 tokens
  FIXED_OVERLAP: 50, // characters — ~12 tokens overlap
  SENTENCE_MAX_TOKENS: 200, // tokens — ~800 characters
  SENTENCE_MIN_TOKENS: 10, // minimum before we bother creating a chunk
  RECURSIVE_MAX_SIZE: 512, // characters
  RECURSIVE_OVERLAP: 50, // characters
} as const

export class ChunkingService {
  // ── Strategy 1: Fixed-Size Chunking ────────────────────────────────────
  // The simplest strategy. Splits every N characters with M-character overlap.
  //
  // BEST FOR: Quick prototyping, uniform documents, technical manuals
  // WORST FOR: Documents where sentences frequently span chunk boundaries
  //
  // OVERLAP EXPLAINED:
  // chunkSize=512, overlap=50 means:
  //   Chunk 0: chars 0   → 512
  //   Chunk 1: chars 462 → 974   (starts 50 chars before the previous chunk ended)
  //   Chunk 2: chars 924 → 1436
  // The 50-char overlap ensures facts at chunk boundaries appear in both chunks.
  chunkFixed(text: string, config: Partial<FixedChunkConfig> = {}): RawChunk[] {
    const chunkSize = config.chunkSize ?? DEFAULTS.FIXED_CHUNK_SIZE
    const overlap = config.overlap ?? DEFAULTS.FIXED_OVERLAP
    const start = Date.now()

    // Guard: overlap must be less than chunkSize or we get infinite loops
    if (overlap >= chunkSize) {
      throw new Error(`overlap (${overlap}) must be less than chunkSize (${chunkSize})`)
    }

    // Guard: empty or whitespace-only text produces no useful chunks
    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return []
    }

    const chunks: RawChunk[] = []
    let index = 0
    let chunkIndex = 0

    while (index < trimmed.length) {
      const end = Math.min(index + chunkSize, trimmed.length)
      const content = trimmed.slice(index, end)

      // Skip chunks that are only whitespace
      if (content.trim().length > 0) {
        chunks.push({
          content,
          chunkIndex,
          tokenCount: this.estimateTokens(content),
          characterCount: content.length,
          strategy: "fixed" as ChunkingStrategy,
        })
        chunkIndex++
      }

      // Advance by (chunkSize - overlap) to create the sliding window
      index += chunkSize - overlap
    }

    logRagEvent("chunk", "Fixed chunking complete", {
      service: "ChunkingService",
      chunkCount: chunks.length,
      durationMs: Date.now() - start,
    })

    return chunks
  }

  // ── Strategy 2: Sentence-Aware Chunking ───────────────────────────────
  // Groups complete sentences together up to a token limit.
  // Never splits in the middle of a sentence.
  //
  // BEST FOR: FAQ documents, interview transcripts, news articles, Q&A pairs
  // WORST FOR: Very long single sentences (legal contracts, academic abstracts)
  //
  // HOW IT WORKS:
  // 1. Split text on sentence-ending punctuation: "." "!" "?"
  // 2. Accumulate sentences into a buffer
  // 3. When buffer would exceed maxTokens, flush it as a chunk, start fresh
  // 4. The last buffer (even if short) becomes the final chunk
  chunkBySentence(text: string, config: Partial<SentenceChunkConfig> = {}): RawChunk[] {
    const maxTokens = config.maxTokens ?? DEFAULTS.SENTENCE_MAX_TOKENS
    const minTokens = config.minTokens ?? DEFAULTS.SENTENCE_MIN_TOKENS
    const start = Date.now()

    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return []
    }

    // Split on sentence-ending punctuation followed by whitespace or end of string
    // The regex keeps the punctuation attached to the sentence it ends
    // "Hello world. How are you?" → ["Hello world.", " How are you?"]
    const sentencePattern = /[^.!?]*[.!?]+(?:\s|$)/g
    const matched = trimmed.match(sentencePattern)

    // If no sentence boundaries found, treat the entire text as one chunk
    const sentences: string[] = matched ?? [trimmed]

    const chunks: RawChunk[] = []
    let buffer = ""
    let chunkIndex = 0

    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim()
      if (trimmedSentence.length === 0) continue

      const combined = buffer === "" ? trimmedSentence : `${buffer} ${trimmedSentence}`
      const combinedTokens = this.estimateTokens(combined)

      if (combinedTokens > maxTokens && buffer !== "") {
        // Buffer is full — flush it as a chunk before adding this sentence
        if (this.estimateTokens(buffer) >= minTokens) {
          chunks.push({
            content: buffer,
            chunkIndex,
            tokenCount: this.estimateTokens(buffer),
            characterCount: buffer.length,
            strategy: "sentence" as ChunkingStrategy,
          })
          chunkIndex++
        }
        buffer = trimmedSentence
      } else {
        // Sentence fits — add it to the buffer
        buffer = combined
      }
    }

    // Flush the remaining buffer as the final chunk
    if (buffer.trim().length > 0 && this.estimateTokens(buffer) >= minTokens) {
      chunks.push({
        content: buffer.trim(),
        chunkIndex,
        tokenCount: this.estimateTokens(buffer),
        characterCount: buffer.trim().length,
        strategy: "sentence" as ChunkingStrategy,
      })
    }

    logRagEvent("chunk", "Sentence chunking complete", {
      service: "ChunkingService",
      chunkCount: chunks.length,
      durationMs: Date.now() - start,
    })

    return chunks
  }

  // ── Strategy 3: Recursive Chunking ────────────────────────────────────
  // Tries to split on natural document boundaries in order of preference:
  // paragraph breaks → sentence endings → word boundaries → characters
  // Stops as soon as a split produces chunks under the size limit.
  //
  // BEST FOR: Mixed documents (PDFs with headers, markdown, structured reports)
  //           This is the default strategy used by LangChain's RecursiveCharacterTextSplitter
  // WHY IT'S BETTER THAN FIXED:
  // Fixed chunking blindly splits at position N, potentially mid-sentence.
  // Recursive tries paragraph breaks first — only falling back to finer
  // splits if paragraphs are too large.
  chunkRecursive(text: string, config: Partial<RecursiveChunkConfig> = {}): RawChunk[] {
    const maxChunkSize = config.maxChunkSize ?? DEFAULTS.RECURSIVE_MAX_SIZE
    const overlap = config.overlap ?? DEFAULTS.RECURSIVE_OVERLAP
    const separators = config.separators ?? [
      "\n\n", // paragraph break — try this first
      "\n", // line break
      ". ", // sentence ending
      "! ", // exclamation
      "? ", // question
      ", ", // clause boundary
      " ", // word boundary
      "", // character-by-character (last resort)
    ]
    const start = Date.now()

    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return []
    }

    // Split the text recursively using the separator hierarchy
    const rawContents = this.splitRecursively(trimmed, separators, maxChunkSize, overlap)

    // Convert raw content strings to RawChunk objects
    const chunks: RawChunk[] = rawContents
      .filter(content => content.trim().length > 0)
      .map((content, index) => ({
        content: content.trim(),
        chunkIndex: index,
        tokenCount: this.estimateTokens(content),
        characterCount: content.trim().length,
        strategy: "recursive" as ChunkingStrategy,
      }))

    logRagEvent("chunk", "Recursive chunking complete", {
      service: "ChunkingService",
      chunkCount: chunks.length,
      durationMs: Date.now() - start,
    })

    return chunks
  }

  // ── Public Utility: Choose Strategy By Name ───────────────────────────
  // Allows calling code to select a strategy dynamically.
  // Used by IngestionService (Day 8): "chunk this document using strategy X"
  chunk(
    text: string,
    strategy: ChunkingStrategy,
    config: Partial<FixedChunkConfig | SentenceChunkConfig | RecursiveChunkConfig> = {}
  ): RawChunk[] {
    switch (strategy) {
      case "fixed":
        return this.chunkFixed(text, config as Partial<FixedChunkConfig>)
      case "sentence":
        return this.chunkBySentence(text, config as Partial<SentenceChunkConfig>)
      case "recursive":
        return this.chunkRecursive(text, config as Partial<RecursiveChunkConfig>)
      case "semantic":
        // Semantic chunking requires embeddings — implemented in Day 8+
        // For now, fall back to recursive
        return this.chunkRecursive(text, config as Partial<RecursiveChunkConfig>)
      default: {
        // TypeScript exhaustiveness check — this line is unreachable
        // but ensures the compiler tells you if a new strategy is added
        // to the type without being handled here
        const _exhaustive: never = strategy
        throw new Error(`Unknown chunking strategy: ${String(_exhaustive)}`)
      }
    }
  }

  // ── Public Utility: Estimate Token Count ──────────────────────────────
  // Rule of thumb: 4 characters ≈ 1 token for English text.
  // This is a cheap heuristic (no API call needed).
  // Real token counting uses tiktoken — accurate but requires a library.
  // For chunking decisions, this estimate is close enough.
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  // ── Public Utility: Validate Chunk Quality ────────────────────────────
  // Run this after chunking to catch degenerate results.
  // Returns a list of warnings — empty array means all chunks look healthy.
  validateChunks(chunks: RawChunk[]): string[] {
    const warnings: string[] = []

    if (chunks.length === 0) {
      warnings.push("Chunking produced zero chunks — input text may be empty")
      return warnings
    }

    const tooSmall = chunks.filter(c => c.tokenCount < 10)
    const tooLarge = chunks.filter(c => c.tokenCount > 1000)
    const duplicate = this.findDuplicates(chunks)

    if (tooSmall.length > 0) {
      warnings.push(
        `${tooSmall.length} chunks have fewer than 10 tokens — ` +
          `consider increasing minTokens or chunkSize`
      )
    }

    if (tooLarge.length > 0) {
      warnings.push(
        `${tooLarge.length} chunks exceed 1000 tokens — ` + `consider decreasing chunkSize`
      )
    }

    if (duplicate.length > 0) {
      warnings.push(`${duplicate.length} duplicate chunks detected — ` + `overlap may be too large`)
    }

    return warnings
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  // Core recursive splitting algorithm.
  // Tries each separator in order. If a split produces pieces within the
  // size limit, it uses those pieces. Otherwise it recurses with the
  // next separator in the list.
  private splitRecursively(
    text: string,
    separators: string[],
    maxSize: number,
    overlap: number
  ): string[] {
    // If text is empty, return empty array
    if (text.trim().length === 0) {
      return []
    }

    const currentSeparator = separators[0]
    const remainingSeparators = separators.slice(1)

    // Base case: No more separators to try, or current separator is the last resort ("").
    // If the text fits within maxSize, return it as a single chunk. Otherwise, force split.
    if (currentSeparator === undefined || currentSeparator === "") {
      if (text.length <= maxSize) return [text]
      return this.forceChunkWithOverlap(text, maxSize, overlap)
    }

    // Try splitting on the current separator
    const pieces = text.split(currentSeparator).filter(p => p.trim().length > 0)

    // If this separator did not split the text into multiple pieces, try the next separator.
    if (pieces.length <= 1) {
      // If the text doesn't split with the current separator AND it fits within maxSize,
      // then return it as is, without trying further separators.
      if (text.length <= maxSize) return [text]
      return this.splitRecursively(text, remainingSeparators, maxSize, overlap)
    }

    // If we successfully split the text into multiple pieces:
    const result: string[] = []
    // Process each piece: if it's too large, recurse; otherwise, add it.
    // This approach directly adds small pieces and recurses on large ones.
    for (const piece of pieces) {
      if (piece.length <= maxSize) {
        // This piece is small enough, add it directly to the result.
        result.push(piece)
      } else {
        // This piece is too large, recurse with the remaining separators.
        const subChunks = this.splitRecursively(piece, remainingSeparators, maxSize, overlap)
        result.push(...subChunks)
      }
    }
    return result
  }

  // Force-split a string by character count with overlap.
  // Used as the last resort when no separator works.
  private forceChunkWithOverlap(text: string, maxSize: number, overlap: number): string[] {
    const chunks: string[] = []
    let index = 0

    while (index < text.length) {
      const end = Math.min(index + maxSize, text.length)
      chunks.push(text.slice(index, end))
      index += maxSize - overlap
    }

    return chunks
  }

  // Find chunks with identical content — a sign of excessive overlap
  private findDuplicates(chunks: RawChunk[]): RawChunk[] {
    const seen = new Set<string>()
    const dupes: RawChunk[] = []

    for (const chunk of chunks) {
      const key = chunk.content.trim().toLowerCase()
      if (seen.has(key)) {
        dupes.push(chunk)
      } else {
        seen.add(key)
      }
    }

    return dupes
  }
}
