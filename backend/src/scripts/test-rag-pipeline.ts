/* eslint-disable no-console */
// backend/src/scripts/test-rag-pipeline.ts
// Full end-to-end RAG test: question → retrieve → generate → cited answer.
// Calls the REAL Gemini API. Run after ingesting at least one document.
//
// Usage: npx ts-node src/scripts/test-rag-pipeline.ts

import dotenv from "dotenv"
dotenv.config()

import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { GenerationService } from "../services/generation.service"
import { RagService } from "../services/rag.service"
import redis from "../utils/redis"

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY

  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    console.error("❌ GEMINI_API_KEY not set in .env")
    process.exit(1)
  }

  const prisma = new PrismaClient()
  const embeddingService = new EmbeddingService(apiKey, redis)
  const hybridSearch = new HybridSearchService(prisma, embeddingService)
  const generationService = new GenerationService(apiKey)
  const ragService = new RagService(hybridSearch, generationService)

  console.log("=".repeat(65))
  console.log("FULL RAG PIPELINE — END-TO-END TEST")
  console.log("=".repeat(65))
  console.log("Pipeline: Question → Embed → Hybrid Search → Generate → Answer")
  console.log()

  const queries = [
    "What is machine learning?",
    "What is the difference between supervised and unsupervised learning?",
    "What does quantum mechanics say about black holes?", // out-of-scope — should get fallback
  ]

  for (const query of queries) {
    console.log("─".repeat(65))
    console.log(`QUESTION: "${query}"`)
    console.log()

    const start = Date.now()
    const result = await ragService.query(query, { topK: 5 })
    const total = Date.now() - start

    console.log(`ANSWER:`)
    console.log(`  ${result.answer}`)
    console.log()

    if (result.citations.length > 0) {
      console.log(`CITATIONS (${result.citations.length}):`)
      result.citations.forEach((citation, i) => {
        console.log(`  [Source ${i + 1}] ${citation.documentName}`)
        console.log(`    Score: ${citation.relevanceScore.toFixed(5)}`)
        console.log(`    Excerpt: "${citation.excerpt.slice(0, 80)}..."`)
      })
      console.log()
    } else {
      console.log("CITATIONS: none (fallback response — no chunks retrieved)")
      console.log()
    }

    console.log(`METRICS:`)
    console.log(`  Chunks retrieved:  ${result.chunksRetrieved}`)
    console.log(`  Chunks used:       ${result.chunksUsed}`)
    console.log(`  Tokens consumed:   ${result.tokensUsed}`)
    console.log(`  Retrieval time:    ${result.retrievalMs}ms`)
    console.log(`  Generation time:   ${result.generationMs}ms`)
    console.log(`  Total time:        ${total}ms`)
    console.log()
  }

  // ── Hallucination test ────────────────────────────────────────────────
  console.log("─".repeat(65))
  console.log("HALLUCINATION TEST:")
  console.log('Query: "What does quantum mechanics say about black holes?"')
  console.log("(This should NOT be in any ingested document)")
  console.log()

  const outOfScope = await ragService.query(
    "What does quantum mechanics say about black holes?",
    { topK: 5, minSimilarity: 0.7 } // high threshold — almost nothing should match
  )

  console.log(`Result: "${outOfScope.answer}"`)
  console.log()

  const isGrounded =
    outOfScope.answer.toLowerCase().includes("don't have") ||
    outOfScope.answer.toLowerCase().includes("not enough") ||
    outOfScope.answer.toLowerCase().includes("no information") ||
    outOfScope.chunksRetrieved === 0

  if (isGrounded) {
    console.log("✅ PASS: System refused to hallucinate on out-of-scope question")
  } else {
    console.log("⚠️  REVIEW: System may have answered from training data — check the response")
    console.log("   Solution: increase minSimilarity or improve the system prompt")
  }

  console.log()
  console.log("✅ Full RAG pipeline test complete!")

  await prisma.$disconnect()
  await redis.quit()
}

main().catch((error: unknown) => {
  console.error("❌ Test failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
