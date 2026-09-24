import type {
  RawChunk,
  ChunkingStrategy,
  FixedChunkConfig,
  SentenceChunkConfig,
  RecursiveChunkConfig,
} from "../types/document.types"
import { logRagEvent } from "../utils/logger"

const DEFAULTS = {
  FIXED_CHUNK_SIZE: 512, // characters — ~128 tokens
  FIXED_OVERLAP: 50, // characters — ~12 tokens overlap
  SENTENCE_MAX_TOKENS: 200, // tokens — ~800 characters
  SENTENCE_MIN_TOKENS: 10, // minimum before we bother creating a chunk
  RECURSIVE_MAX_SIZE: 512, // characters
  RECURSIVE_OVERLAP: 50, // characters
} as const

export class ChunkingService {
  chunkFixed(text: string, config: Partial<FixedChunkConfig> = {}): RawChunk[] {
    const chunkSize = config.chunkSize ?? DEFAULTS.FIXED_CHUNK_SIZE
    const overlap = config.overlap ?? DEFAULTS.FIXED_OVERLAP
    const start = Date.now()

    if (overlap >= chunkSize) {
      throw new Error(`overlap (${overlap}) must be less than chunkSize (${chunkSize})`)
    }

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

      index += chunkSize - overlap
    }

    logRagEvent("chunk", "Fixed chunking complete", {
      service: "ChunkingService",
      chunkCount: chunks.length,
      durationMs: Date.now() - start,
    })

    return chunks
  }

  chunkBySentence(text: string, config: Partial<SentenceChunkConfig> = {}): RawChunk[] {
    const maxTokens = config.maxTokens ?? DEFAULTS.SENTENCE_MAX_TOKENS
    const minTokens = config.minTokens ?? DEFAULTS.SENTENCE_MIN_TOKENS
    const start = Date.now()

    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return []
    }

    const sentencePattern = /[^.!?]*[.!?]+(?:\s|$)/g
    const matched = trimmed.match(sentencePattern)

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
        buffer = combined
      }
    }

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

    const rawContents = this.splitRecursively(trimmed, separators, maxChunkSize, overlap)

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
        return this.chunkRecursive(text, config as Partial<RecursiveChunkConfig>)
      default: {
        const _exhaustive: never = strategy
        throw new Error(`Unknown chunking strategy: ${String(_exhaustive)}`)
      }
    }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

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

  private splitRecursively(
    text: string,
    separators: string[],
    maxSize: number,
    overlap: number
  ): string[] {
    if (text.trim().length === 0) {
      return []
    }

    const currentSeparator = separators[0]
    const remainingSeparators = separators.slice(1)

    if (currentSeparator === undefined || currentSeparator === "") {
      if (text.length <= maxSize) return [text]
      return this.forceChunkWithOverlap(text, maxSize, overlap)
    }

    const pieces = text.split(currentSeparator).filter(p => p.trim().length > 0)

    if (pieces.length <= 1) {
      if (text.length <= maxSize) return [text]
      return this.splitRecursively(text, remainingSeparators, maxSize, overlap)
    }

    const result: string[] = []
    for (const piece of pieces) {
      if (piece.length <= maxSize) {
        result.push(piece)
      } else {
        const subChunks = this.splitRecursively(piece, remainingSeparators, maxSize, overlap)
        result.push(...subChunks)
      }
    }
    return result
  }

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
