/* eslint-disable no-console */
// backend/src/scripts/test-hybrid-search.ts
// End-to-end demonstration of hybrid vs vector-only vs keyword-only.
// Shows WHERE each strategy succeeds and fails.
// Run AFTER ingesting at least one document.
//
// Usage: npx ts-node src/scripts/test-hybrid-search.ts

import dotenv from "dotenv"
dotenv.config()

import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import redis from "../utils/redis"

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY

  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    console.error("❌ GEMINI_API_KEY not set in .env")
    process.exit(1)
  }

  const prisma = new PrismaClient()
  const embeddingService = new EmbeddingService(apiKey, redis)
  const hybridService = new HybridSearchService(prisma, embeddingService)

  console.log("=".repeat(65))
  console.log("HYBRID SEARCH — STRATEGY COMPARISON")
  console.log("=".repeat(65))

  // ── Test queries ──────────────────────────────────────────────────────
  // These are designed to show different failure modes:
  const testCases = [
    {
      query: "What is machine learning?",
      description: "Broad semantic query — all strategies should do well",
    },
    {
      query: "learning",
      description: "Single keyword — keyword search should excel",
    },
    {
      query: "How do systems improve without explicit programming?",
      description: "Paraphrase — vector search should excel (no exact keywords)",
    },
  ]

  for (const testCase of testCases) {
    console.log(`\n${"─".repeat(65)}`)
    console.log(`QUERY:       "${testCase.query}"`)
    console.log(`DESCRIPTION: ${testCase.description}`)

    const comparison = await hybridService.compareStrategies(testCase.query, { topK: 3 })

    // ── Vector only results ───────────────────────────────────────────
    console.log(`\n  📐 VECTOR ONLY (${comparison.vectorOnly.length} results):`)
    comparison.vectorOnly.slice(0, 3).forEach((r, i) => {
      console.log(
        `    ${i + 1}. [sim=${r.cosineSimilarity.toFixed(3)}] ` +
          `"${r.chunk.content.slice(0, 70)}..."`
      )
    })

    // ── Keyword only results ──────────────────────────────────────────
    console.log(`\n  🔤 KEYWORD ONLY (${comparison.keywordOnly.length} results):`)
    if (comparison.keywordOnly.length === 0) {
      console.log("    (no keyword matches found)")
    } else {
      comparison.keywordOnly.slice(0, 3).forEach((r, i) => {
        console.log(
          `    ${i + 1}. [bm25=${r.bm25Score.toFixed(4)}] ` + `"${r.chunk.content.slice(0, 70)}..."`
        )
      })
    }

    // ── Hybrid results ────────────────────────────────────────────────
    console.log(`\n  🔀 HYBRID / RRF (${comparison.hybrid.length} results):`)
    comparison.hybrid.slice(0, 3).forEach((r, i) => {
      const inVector = r.vectorRank !== 999 ? `v=${r.vectorRank}` : "v=—"
      const inKeyword = r.keywordRank !== 999 ? `k=${r.keywordRank}` : "k=—"
      console.log(
        `    ${i + 1}. [rrf=${r.rrfScore.toFixed(5)} | ${inVector} ${inKeyword}] ` +
          `"${r.chunk.content.slice(0, 60)}..."`
      )
    })

    // ── Overlap analysis ──────────────────────────────────────────────
    console.log(`\n  📊 OVERLAP ANALYSIS:`)
    console.log(`    In both lists:     ${comparison.inBoth.length} chunks`)
    console.log(`    Only in vector:    ${comparison.onlyInVector.length} chunks`)
    console.log(`    Only in keyword:   ${comparison.onlyInKeyword.length} chunks`)

    if (comparison.onlyInVector.length > 0) {
      console.log(`    → Vector finds chunks keyword MISSES (semantic gap)`)
    }
    if (comparison.onlyInKeyword.length > 0) {
      console.log(`    → Keyword finds chunks vector MISSES (exact term gap)`)
    }
    if (comparison.inBoth.length > 0) {
      console.log(
        `    → ${comparison.inBoth.length} chunk(s) in both — these rank HIGHEST in hybrid`
      )
    }
  }

  // ── Citation format preview ───────────────────────────────────────────
  console.log(`\n${"─".repeat(65)}`)
  console.log("CITATION FORMAT (what the frontend will display):")

  const hybridResults = await hybridService.search("What is machine learning?", { topK: 2 })
  const citations = hybridService.toCitations(hybridResults)

  citations.forEach((citation, i) => {
    console.log(`\n  Citation ${i + 1}:`)
    console.log(`    Document: ${citation.documentName}`)
    console.log(`    Score:    ${citation.relevanceScore.toFixed(5)}`)
    console.log(`    Excerpt:  "${citation.excerpt}"`)
  })

  console.log("\n✅ Hybrid search comparison complete!")

  await prisma.$disconnect()
  await redis.quit()
}

main().catch((error: unknown) => {
  console.error("❌ Test failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
