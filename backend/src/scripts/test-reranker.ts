/* eslint-disable no-console */
// backend/src/scripts/test-reranker.ts
// End-to-end demonstration of reranking quality improvement.
// Shows before/after comparison for the same query.
//
// Usage: npx ts-node src/scripts/test-reranker.ts

import dotenv from "dotenv"
dotenv.config()

import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { RerankerService } from "../services/reranker.service"
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
  const rerankerService = new RerankerService(apiKey)

  console.log("=".repeat(65))
  console.log("RERANKER — BEFORE/AFTER COMPARISON")
  console.log("=".repeat(65))
  console.log()

  const queries = [
    "What are the main challenges in machine learning?",
    "How does supervised learning work?",
    "What is the difference between AI and machine learning?",
  ]

  for (const query of queries) {
    console.log("─".repeat(65))
    console.log(`QUERY: "${query}"`)
    console.log()

    // ── Step 1: Hybrid search (before reranking) ──────────────────────
    const hybridResults = await hybridService.search(query, { topK: 6 })

    if (hybridResults.length === 0) {
      console.log("  No results found — upload a document first")
      console.log()
      continue
    }

    console.log(`BEFORE RERANKING (RRF order, top ${hybridResults.length}):`)
    hybridResults.forEach((r, i) => {
      console.log(
        `  ${i + 1}. [rrf=${r.rrfScore.toFixed(4)}] ` + `"${r.chunk.content.slice(0, 70)}..."`
      )
    })
    console.log()

    // ── Step 2: Rerank ────────────────────────────────────────────────
    const reranked = await rerankerService.rerank(query, hybridResults, {
      topK: Math.min(hybridResults.length, 5),
    })

    console.log(`AFTER RERANKING (cross-encoder order):`)
    reranked.forEach((r, i) => {
      const rankChange = r.originalRank - r.rerankedRank // positive = moved up
      const changeStr =
        rankChange > 0 ? `↑${rankChange}` : rankChange < 0 ? `↓${Math.abs(rankChange)}` : "→"

      console.log(
        `  ${i + 1}. [rerank=${r.rerankScore.toFixed(2)} | ${changeStr}] ` +
          `"${r.chunk.content.slice(0, 70)}..."`
      )
    })
    console.log()

    // ── Step 3: Compare ───────────────────────────────────────────────
    const movedUp = reranked.filter(r => r.rerankedRank < r.originalRank).length
    const movedDown = reranked.filter(r => r.rerankedRank > r.originalRank).length
    const unchanged = reranked.filter(r => r.rerankedRank === r.originalRank).length

    console.log(`IMPACT:`)
    console.log(`  ↑ ${movedUp} chunk(s) moved to higher position (more relevant)`)
    console.log(`  ↓ ${movedDown} chunk(s) moved to lower position (less relevant)`)
    console.log(`  → ${unchanged} chunk(s) position unchanged`)
    console.log()
  }

  // ── Reranker quality check ────────────────────────────────────────────
  console.log("─".repeat(65))
  console.log("QUALITY SIGNAL:")
  console.log("If movedUp > 0: reranker found better ordering than RRF alone.")
  console.log("If all unchanged: your documents may be too similar to distinguish.")
  console.log("If all movedDown: check that your documents are relevant to the queries.")

  console.log("\n✅ Reranker comparison complete!")

  await prisma.$disconnect()
  await redis.quit()
}

main().catch((error: unknown) => {
  console.error("❌ Test failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
