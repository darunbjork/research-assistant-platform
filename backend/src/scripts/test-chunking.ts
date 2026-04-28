/* eslint-disable no-console */
// backend/src/scripts/test-chunking.ts
// Run this to see chunking in action with real output.
// Not a test file — a development tool.
// Usage: npx ts-node src/scripts/test-chunking.ts

import { ChunkingService } from "../services/chunking.service"

const service = new ChunkingService()

const sampleDocument = `
Introduction to Retrieval-Augmented Generation

Retrieval-Augmented Generation (RAG) is a technique that enhances large language
models by giving them access to external knowledge. Instead of relying solely on
patterns learned during training, a RAG system retrieves relevant documents at
query time and provides them as context to the language model.

How RAG Works

The RAG pipeline consists of two main phases. The first phase is ingestion, where
documents are split into chunks, converted into vector embeddings, and stored in
a vector database. This phase runs once when new documents are uploaded.

The second phase is retrieval. When a user asks a question, the system embeds the
query using the same embedding model. It then searches the vector database for
chunks whose embeddings are most similar to the query embedding. The top matching
chunks are retrieved and provided as context to the language model.

Why RAG Reduces Hallucination

Language models sometimes generate plausible-sounding but factually incorrect
information, a phenomenon known as hallucination. RAG reduces hallucination by
grounding the model's response in retrieved documents. The system prompt instructs
the model to only use information from the provided context, and to acknowledge
when the context does not contain a sufficient answer.
`.trim()

console.log("=".repeat(60))
console.log("CHUNKING STRATEGY COMPARISON")
console.log("=".repeat(60))
console.log(`Input: ${sampleDocument.length} characters`)
console.log(`Estimated tokens: ${service.estimateTokens(sampleDocument)}`)
console.log("")

// Strategy 1: Fixed
const fixedChunks = service.chunkFixed(sampleDocument, { chunkSize: 300, overlap: 30 })
console.log(`FIXED (chunkSize=300, overlap=30): ${fixedChunks.length} chunks`)
fixedChunks.forEach((chunk, i) => {
  console.log(`  Chunk ${i}: ${chunk.characterCount} chars / ${chunk.tokenCount} tokens`)
  console.log(`    "${chunk.content.slice(0, 80)}..."`)
})
console.log("")

// Strategy 2: Sentence
const sentenceChunks = service.chunkBySentence(sampleDocument, { maxTokens: 80, minTokens: 10 })
console.log(`SENTENCE (maxTokens=80): ${sentenceChunks.length} chunks`)
sentenceChunks.forEach((chunk, i) => {
  console.log(`  Chunk ${i}: ${chunk.tokenCount} tokens`)
  console.log(`    "${chunk.content.slice(0, 80)}..."`)
})
console.log("")

// Strategy 3: Recursive
const recursiveChunks = service.chunkRecursive(sampleDocument, { maxChunkSize: 300, overlap: 30 })
console.log(`RECURSIVE (maxChunkSize=300): ${recursiveChunks.length} chunks`)
recursiveChunks.forEach((chunk, i) => {
  console.log(`  Chunk ${i}: ${chunk.characterCount} chars / ${chunk.tokenCount} tokens`)
  console.log(`    "${chunk.content.slice(0, 80)}..."`)
})
console.log("")

// Validation
console.log("VALIDATION:")
const warnings = service.validateChunks(recursiveChunks)
if (warnings.length === 0) {
  console.log("  ✅ All chunks passed validation")
} else {
  warnings.forEach(w => console.log(`  ⚠️  ${w}`))
}
