/* eslint-disable no-console */
// backend/src/scripts/test-vector-search.ts
// End-to-end test: embed a question → search pgvector → see which chunks surface.
// This calls the REAL Gemini API and the REAL database.
// Run AFTER you have ingested at least one document via POST /api/v1/documents/ingest
//
// Usage: npx ts-node src/scripts/test-vector-search.ts

import dotenv from "dotenv"
dotenv.config()

import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { VectorSearchService } from "../services/vector.search.service"
import redis from "../utils/redis"

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY

  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    console.error("❌ GEMINI_API_KEY not set in .env")
    process.exit(1)
  }

  const prisma = new PrismaClient()
  const embeddingService = new EmbeddingService(apiKey, redis)
  const searchService = new VectorSearchService(prisma)

  console.log("=".repeat(60))
  console.log("VECTOR SEARCH — END-TO-END TEST")
  console.log("=".repeat(60))

  // ── Check how many chunks are in the database ─────────────────────────
  const stats = await searchService.getIndexStats()
  console.log(`\nDatabase state:`)
  console.log(`  Total chunks: ${stats.totalChunks}`)
  console.log(
    `  Index exists: ${stats.indexExists ? "✅ yes" : "⚠️  no (run add_vector_index.sql)"}`
  )

  if (stats.totalChunks === 0) {
    console.log("\n⚠️  No chunks in database.")
    console.log("   First ingest a document:")
    console.log("   POST /api/v1/documents/ingest")
    console.log("   Then run this script again.")
    await cleanup(prisma)
    return
  }

  // ── Test queries ──────────────────────────────────────────────────────
  const queries = [
    "What is machine learning?",
    "How do neural networks work?",
    "What is the difference between supervised and unsupervised learning?",
  ]

  for (const query of queries) {
    console.log(`\n${"─".repeat(50)}`)
    console.log(`QUERY: "${query}"`)

    const start = Date.now()
    const queryVector = await embeddingService.embedText(query, "RETRIEVAL_QUERY")
    const embedMs = Date.now() - start

    console.log(`  Embedding time: ${embedMs}ms`)

    const searchStart = Date.now()
    const results = await searchService.search(queryVector, {
      topK: 3,
      minSimilarity: 0.5,
    })
    const searchMs = Date.now() - searchStart

    console.log(`  Search time:    ${searchMs}ms`)
    console.log(`  Results found:  ${results.length}`)

    if (results.length === 0) {
      console.log("  (No results above 0.5 similarity threshold)")
      continue
    }

    results.forEach((result, i) => {
      console.log(`\n  Result ${i + 1}:`)
      console.log(`    Similarity: ${result.cosineSimilarity.toFixed(4)}`)
      console.log(`    Source:     ${result.chunk.source}`)
      console.log(`    Chunk #:    ${result.chunk.chunkIndex}`)
      console.log(`    Preview:    "${result.chunk.content.slice(0, 100)}..."`)
    })
  }

  // ── Similarity explanation test ───────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`)
  console.log("SIMILARITY EXPLANATION TEST")
  console.log("(Shows the exact similarity score between a query and a specific chunk)")

  const testQuery = "What is machine learning?"
  const queryVector = await embeddingService.embedText(testQuery, "RETRIEVAL_QUERY")

  // Get the ID of the first chunk in the database
  const firstChunks = await searchService.search(queryVector, { topK: 1 })
  const firstChunk = firstChunks[0]

  if (firstChunk !== undefined) {
    const explanation = await searchService.explainSimilarity(queryVector, firstChunk.chunk.id)

    if (explanation !== null) {
      console.log(`\n  Query:      "${testQuery}"`)
      console.log(`  Chunk ID:   ${explanation.chunkId}`)
      console.log(`  Similarity: ${explanation.similarity.toFixed(4)}`)
      console.log(`  Content:    "${explanation.content.slice(0, 100)}..."`)
    }
  }

  console.log("\n✅ Vector search end-to-end test complete!")

  await cleanup(prisma)
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.$disconnect()
  await redis.quit()
}

main().catch((error: unknown) => {
  console.error("❌ Test failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
