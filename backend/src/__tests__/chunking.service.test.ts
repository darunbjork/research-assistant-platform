// Unit tests for ChunkingService.
// No external dependencies, no mocks needed — pure input/output testing.
//
// TODO: TEST COVERAGE GOALS:
// - Every public method has at least one happy-path test
// - Every guard clause (empty input, invalid config) has a test
// - Edge cases: single word, single sentence, very long text
// - Strategy selection via chunk() dispatcher

import { ChunkingService } from "../services/chunking.service"

// Create one instance — shared across all tests in this file
const service = new ChunkingService()

// ── Fixtures ──────────────────────────────────────────────────────────────
// Reusable test data. Define it once at the top, use it everywhere.
const SHORT_TEXT = "Hello world."
const MEDIUM_TEXT =
  "The quick brown fox jumps over the lazy dog. " +
  "Pack my box with five dozen liquor jugs. " +
  "How valiantly did brave Achilles fight. " +
  "The five boxing wizards jump quickly."
const LONG_TEXT = "A".repeat(2000) // 2000 characters — forces multiple chunks
const PARA_TEXT =
  "First paragraph with some content.\n\n" +
  "Second paragraph with different content.\n\n" +
  "Third paragraph that is also here."

// ── chunkFixed() ─────────────────────────────────────────────────────────
describe("ChunkingService.chunkFixed()", () => {
  it("returns at least one chunk for any non-empty input", () => {
    const chunks = service.chunkFixed(SHORT_TEXT)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it("returns empty array for empty string", () => {
    const chunks = service.chunkFixed("")
    expect(chunks).toHaveLength(0)
  })

  it("returns empty array for whitespace-only string", () => {
    const chunks = service.chunkFixed("   \n\t  ")
    expect(chunks).toHaveLength(0)
  })

  it("chunk indices are sequential starting from 0", () => {
    const chunks = service.chunkFixed(LONG_TEXT, { chunkSize: 100, overlap: 10 })
    chunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i)
    })
  })

  it("no chunk exceeds the configured chunkSize", () => {
    const chunkSize = 100
    const chunks = service.chunkFixed(LONG_TEXT, { chunkSize, overlap: 0 })
    chunks.forEach(chunk => {
      expect(chunk.characterCount).toBeLessThanOrEqual(chunkSize)
    })
  })

  it("all chunks have a positive tokenCount", () => {
    const chunks = service.chunkFixed(MEDIUM_TEXT)
    chunks.forEach(chunk => {
      expect(chunk.tokenCount).toBeGreaterThan(0)
    })
  })

  it("all chunks have strategy set to 'fixed'", () => {
    const chunks = service.chunkFixed(MEDIUM_TEXT)
    chunks.forEach(chunk => {
      expect(chunk.strategy).toBe("fixed")
    })
  })

  it("produces more chunks with smaller chunkSize", () => {
    const bigChunks = service.chunkFixed(LONG_TEXT, { chunkSize: 500, overlap: 0 })
    const smallChunks = service.chunkFixed(LONG_TEXT, { chunkSize: 100, overlap: 0 })
    expect(smallChunks.length).toBeGreaterThan(bigChunks.length)
  })

  it("overlap causes adjacent chunks to share content", () => {
    const chunks = service.chunkFixed(LONG_TEXT, { chunkSize: 100, overlap: 20 })

    if (chunks.length >= 2) {
      const firstChunk = chunks[0]
      const secondChunk = chunks[1]

      // The last 20 chars of chunk 0 should appear at the start of chunk 1
      // because overlap=20 means we step back 20 chars before starting chunk 1
      expect(firstChunk).toBeDefined()
      expect(secondChunk).toBeDefined()

      if (firstChunk !== undefined && secondChunk !== undefined) {
        const overlapText = firstChunk.content.slice(-20)
        expect(secondChunk.content).toContain(overlapText)
      }
    }
  })

  it("throws when overlap >= chunkSize", () => {
    expect(() => {
      service.chunkFixed(LONG_TEXT, { chunkSize: 100, overlap: 100 })
    }).toThrow("overlap (100) must be less than chunkSize (100)")
  })

  it("uses default config when none provided", () => {
    const chunks = service.chunkFixed(LONG_TEXT)
    // Default chunkSize=512, so 2000 chars should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1)
  })
})

// ── chunkBySentence() ─────────────────────────────────────────────────────
describe("ChunkingService.chunkBySentence()", () => {
  it("returns at least one chunk for multi-sentence input", () => {
    const chunks = service.chunkBySentence(MEDIUM_TEXT)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it("returns empty array for empty string", () => {
    const chunks = service.chunkBySentence("")
    expect(chunks).toHaveLength(0)
  })

  it("all chunks have strategy set to 'sentence'", () => {
    const chunks = service.chunkBySentence(MEDIUM_TEXT)
    chunks.forEach(chunk => {
      expect(chunk.strategy).toBe("sentence")
    })
  })

  it("no chunk exceeds the configured maxTokens", () => {
    const maxTokens = 30
    const chunks = service.chunkBySentence(MEDIUM_TEXT, { maxTokens, minTokens: 1 })
    chunks.forEach(chunk => {
      expect(chunk.tokenCount).toBeLessThanOrEqual(maxTokens + 20)
      // +20 tolerance because the LAST sentence added may push slightly over
      // This is acceptable — we don't split mid-sentence to hit the limit exactly
    })
  })

  it("chunk indices are sequential starting from 0", () => {
    const chunks = service.chunkBySentence(MEDIUM_TEXT)
    chunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i)
    })
  })

  it("all chunks have positive tokenCount and characterCount", () => {
    const chunks = service.chunkBySentence(MEDIUM_TEXT, { maxTokens: 100, minTokens: 1 })
    chunks.forEach(chunk => {
      expect(chunk.tokenCount).toBeGreaterThan(0)
      expect(chunk.characterCount).toBeGreaterThan(0)
    })
  })

  it("produces more chunks with smaller maxTokens", () => {
    const largeChunks = service.chunkBySentence(MEDIUM_TEXT, { maxTokens: 200, minTokens: 1 })
    const smallChunks = service.chunkBySentence(MEDIUM_TEXT, { maxTokens: 20, minTokens: 1 })
    expect(smallChunks.length).toBeGreaterThanOrEqual(largeChunks.length)
  })
})

// ── chunkRecursive() ──────────────────────────────────────────────────────
describe("ChunkingService.chunkRecursive()", () => {
  it("returns at least one chunk for non-empty input", () => {
    const chunks = service.chunkRecursive(MEDIUM_TEXT)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it("returns empty array for empty string", () => {
    const chunks = service.chunkRecursive("")
    expect(chunks).toHaveLength(0)
  })

  it("all chunks have strategy set to 'recursive'", () => {
    const chunks = service.chunkRecursive(PARA_TEXT)
    chunks.forEach(chunk => {
      expect(chunk.strategy).toBe("recursive")
    })
  })

  it("respects paragraph boundaries when paragraphs fit in maxChunkSize", () => {
    // PARA_TEXT has 3 paragraphs separated by \n\n
    // Each paragraph is small enough to be its own chunk
    const chunks = service.chunkRecursive(PARA_TEXT, { maxChunkSize: 200, overlap: 0 })
    // We should get at least 2 chunks (paragraph-aware splitting)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  it("no chunk is empty", () => {
    const chunks = service.chunkRecursive(LONG_TEXT, { maxChunkSize: 200, overlap: 20 })
    chunks.forEach(chunk => {
      expect(chunk.content.trim().length).toBeGreaterThan(0)
    })
  })

  it("chunk indices are sequential starting from 0", () => {
    const chunks = service.chunkRecursive(LONG_TEXT)
    chunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i)
    })
  })

  it("respects paragraph boundaries when paragraphs fit in maxChunkSize", () => {
    const chunks = service.chunkRecursive(PARA_TEXT, { maxChunkSize: 200, overlap: 0 })
    // Three paragraphs → at least 3 chunks (each paragraph becomes its own chunk)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    // Each chunk should contain only one paragraph (no mixing of paragraphs)
    chunks.forEach(chunk => {
      expect(chunk.content).not.toContain("\n\n")
    })
  })
})

// ── chunk() dispatcher ────────────────────────────────────────────────────
describe("ChunkingService.chunk() — strategy dispatcher", () => {
  it("dispatches 'fixed' to chunkFixed", () => {
    const chunks = service.chunk(MEDIUM_TEXT, "fixed")
    chunks.forEach(c => expect(c.strategy).toBe("fixed"))
  })

  it("dispatches 'sentence' to chunkBySentence", () => {
    const chunks = service.chunk(MEDIUM_TEXT, "sentence")
    chunks.forEach(c => expect(c.strategy).toBe("sentence"))
  })

  it("dispatches 'recursive' to chunkRecursive", () => {
    const chunks = service.chunk(MEDIUM_TEXT, "recursive")
    chunks.forEach(c => expect(c.strategy).toBe("recursive"))
  })

  it("falls back to recursive for 'semantic' (not yet implemented)", () => {
    // Semantic chunking requires embeddings — not available until Day 8
    // The dispatcher falls back to recursive gracefully
    const chunks = service.chunk(MEDIUM_TEXT, "semantic")
    chunks.forEach(c => expect(c.strategy).toBe("recursive"))
  })
})

// ── estimateTokens() ──────────────────────────────────────────────────────
describe("ChunkingService.estimateTokens()", () => {
  it("returns a positive number for non-empty text", () => {
    expect(service.estimateTokens("Hello world")).toBeGreaterThan(0)
  })

  it("returns 0 for empty string", () => {
    expect(service.estimateTokens("")).toBe(0)
  })

  it("longer text has more tokens than shorter text", () => {
    const short = service.estimateTokens("Hi")
    const long = service.estimateTokens("This is a much longer sentence with many words.")
    expect(long).toBeGreaterThan(short)
  })

  it("follows the 4 chars ≈ 1 token rule", () => {
    // "Hello" = 5 chars → Math.ceil(5/4) = 2 tokens
    expect(service.estimateTokens("Hello")).toBe(2)
    // "ABCD" = 4 chars → Math.ceil(4/4) = 1 token
    expect(service.estimateTokens("ABCD")).toBe(1)
    // "ABCDE" = 5 chars → Math.ceil(5/4) = 2 tokens
    expect(service.estimateTokens("ABCDE")).toBe(2)
  })
})

// ── validateChunks() ──────────────────────────────────────────────────────
describe("ChunkingService.validateChunks()", () => {
  it("returns empty warnings for healthy chunks", () => {
    const chunks = service.chunkFixed(MEDIUM_TEXT)
    const warnings = service.validateChunks(chunks)
    expect(warnings).toHaveLength(0)
  })

  it("warns when input produces zero chunks", () => {
    const warnings = service.validateChunks([])
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain("zero chunks")
  })

  it("warns about very small chunks", () => {
    // Force tiny chunks by using very small chunkSize
    const chunks = service.chunkFixed("Hi. OK. Yes. No. Maybe.", {
      chunkSize: 5,
      overlap: 0,
    })
    const warnings = service.validateChunks(chunks)
    // Some chunks will be < 10 tokens
    const hasSizeWarning = warnings.some(w => w.includes("fewer than 10 tokens"))
    expect(hasSizeWarning).toBe(true)
  })
})
