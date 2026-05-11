/* eslint-disable no-console */
// backend/src/scripts/test-rag-evaluation.ts
// End-to-end RAG Triad evaluation test.
// Runs a full RAG pipeline, then evaluates the output quality.
//
// Usage: npx ts-node src/scripts/test-rag-evaluation.ts

import dotenv from "dotenv"
dotenv.config()

import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { GenerationService } from "../services/generation.service"
import { RagService } from "../services/rag.service"
import { EvaluatorService } from "../services/evaluator.service"
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
  const evaluatorService = new EvaluatorService(apiKey)

  console.log("=".repeat(65))
  console.log("RAG TRIAD EVALUATION — PIPELINE QUALITY MEASUREMENT")
  console.log("=".repeat(65))
  console.log()

  // ── Test queries ──────────────────────────────────────────────────────
  const testQueries = [
    "What is machine learning?",
    "How do systems learn from data?",
    "What is the capital of Mars?", // out-of-scope — should expose low faithfulness
  ]

  const batchPairs: Array<{
    query: string
    retrievedContext: string[]
    answer: string
  }> = []

  for (const query of testQueries) {
    console.log("─".repeat(65))
    console.log(`QUERY: "${query}"`)
    console.log()

    // ── Step 1: Run RAG pipeline ──────────────────────────────────────
    const ragResult = await ragService.query(query, { topK: 5 })

    console.log(`ANSWER: "${ragResult.answer.slice(0, 150)}..."`)
    console.log(`CHUNKS RETRIEVED: ${ragResult.chunksRetrieved}`)
    console.log()

    // ── Step 2: Evaluate with RAG Triad ──────────────────────────────
    const evalResult = await evaluatorService.evaluate({
      query,
      retrievedContext: ragResult.citations.map(c => c.excerpt),
      answer: ragResult.answer,
    })

    const s = evalResult.scores

    // Visual score bars
    console.log("RAG TRIAD SCORES:")
    console.log(
      `  Context Relevance:  ${scoreBar(s.contextRelevance)} ${(s.contextRelevance * 100).toFixed(0)}%`
    )
    console.log(
      `  Faithfulness:       ${scoreBar(s.faithfulness)}     ${(s.faithfulness * 100).toFixed(0)}%`
    )
    console.log(
      `  Answer Relevance:   ${scoreBar(s.answerRelevance)}  ${(s.answerRelevance * 100).toFixed(0)}%`
    )
    console.log(`  ─────────────────────────────────────────`)
    console.log(
      `  Overall Score:      ${scoreBar(s.overallScore)}     ${(s.overallScore * 100).toFixed(0)}%`
    )
    console.log()
    console.log(`ASSESSMENT: ${evalResult.feedback.overallAssessment}`)
    console.log()

    if (evalResult.recommendations.length > 0) {
      console.log("RECOMMENDATIONS:")
      evalResult.recommendations.forEach(rec => {
        console.log(`  → ${rec.slice(0, 100)}...`)
      })
      console.log()
    }

    // Collect for batch summary
    batchPairs.push({
      query,
      retrievedContext: ragResult.citations.map(c => c.excerpt),
      answer: ragResult.answer,
    })
  }

  // ── Batch summary ─────────────────────────────────────────────────────
  console.log("=".repeat(65))
  console.log("AGGREGATE PIPELINE QUALITY")
  console.log("=".repeat(65))

  // Run batch evaluation to get aggregates
  const batchResult = await evaluatorService.evaluateBatch({ pairs: batchPairs })
  const agg = batchResult.aggregateScores

  console.log()
  console.log(`Queries evaluated: ${batchPairs.length}`)
  console.log()
  console.log("AVERAGE SCORES:")
  console.log(
    `  Context Relevance:  ${(agg.contextRelevance * 100).toFixed(0)}%  ${getGrade(agg.contextRelevance)}`
  )
  console.log(
    `  Faithfulness:       ${(agg.faithfulness * 100).toFixed(0)}%  ${getGrade(agg.faithfulness)}`
  )
  console.log(
    `  Answer Relevance:   ${(agg.answerRelevance * 100).toFixed(0)}%  ${getGrade(agg.answerRelevance)}`
  )
  console.log(
    `  Overall:            ${(agg.overallScore * 100).toFixed(0)}%  ${getGrade(agg.overallScore)}`
  )
  console.log()
  console.log(`Best dimension:  ${batchResult.bestDimension}`)
  console.log(`Worst dimension: ${batchResult.worstDimension}`)
  console.log()

  if (agg.overallScore >= 0.8) {
    console.log("✅ Pipeline quality is PRODUCTION READY (>= 80%)")
  } else if (agg.overallScore >= 0.65) {
    console.log("⚠️  Pipeline quality is ACCEPTABLE but could be improved")
  } else {
    console.log("❌ Pipeline quality needs SIGNIFICANT IMPROVEMENT before production")
  }

  console.log("\n✅ RAG Triad evaluation complete!")

  await prisma.$disconnect()
  await redis.quit()
}

// ── Helpers ───────────────────────────────────────────────────────────────

function scoreBar(score: number): string {
  const filled = Math.round(score * 10)
  const empty = 10 - filled
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`
}

function getGrade(score: number): string {
  if (score >= 0.85) return "✅ Excellent"
  if (score >= 0.7) return "🟡 Good"
  if (score >= 0.5) return "⚠️  Needs work"
  return "❌ Poor"
}

main().catch((error: unknown) => {
  console.error("❌ Evaluation failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
