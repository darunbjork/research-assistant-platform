/* eslint-disable no-console */
// backend/src/scripts/test-self-correction.ts
// Demonstrates the self-correction mechanism with real API calls.
// Shows how quality scores change between iterations.
//
// Usage: npx ts-node src/scripts/test-self-correction.ts

import dotenv from "dotenv"
dotenv.config()

import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { GenerationService } from "../services/generation.service"
import { AgentService } from "../services/agent.service"
import { EvaluatorNode } from "../agents/nodes/evaluate.node"
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
  const agentService = new AgentService(apiKey, hybridSearch, generationService)
  const evaluator = new EvaluatorNode(apiKey)

  console.log("=".repeat(65))
  console.log("SELF-CORRECTION DEMO — RAG Triad Evaluation")
  console.log("=".repeat(65))

  // ── Demo 1: Heuristic evaluation with different answer qualities ──────
  console.log("\n📊 HEURISTIC EVALUATION DEMO\n")

  const scenarios = [
    {
      label: "No evidence, empty answer",
      toolHistory: [],
      draftAnswer: "",
    },
    {
      label: "Search found nothing",
      toolHistory: [
        {
          toolName: "rag_search" as const,
          input: { query: "xyz" },
          output: "No relevant chunks found for this query.",
          durationMs: 100,
          timestamp: new Date(),
          success: true,
        },
      ],
      draftAnswer: "I don't have enough information.",
    },
    {
      label: "Partial evidence, ungrounded answer",
      toolHistory: [
        {
          toolName: "rag_search" as const,
          input: { query: "machine learning" },
          output: "[Result 1] (source: doc.txt, relevance: 0.03)\nML is a subset of AI.",
          durationMs: 200,
          timestamp: new Date(),
          success: true,
        },
      ],
      draftAnswer: "Machine learning is probably a type of AI. I believe it's important.",
    },
    {
      label: "Good evidence, grounded answer",
      toolHistory: [
        {
          toolName: "rag_search" as const,
          input: { query: "machine learning definition" },
          output:
            "[Result 1] (source: doc.txt, relevance: 0.05)\nMachine learning is a subset of artificial intelligence.",
          durationMs: 200,
          timestamp: new Date(),
          success: true,
        },
        {
          toolName: "rag_search" as const,
          input: { query: "ML learning from data" },
          output:
            "[Result 1] (source: doc.txt, relevance: 0.04)\nML enables systems to learn from data without explicit programming.",
          durationMs: 180,
          timestamp: new Date(),
          success: true,
        },
      ],
      draftAnswer:
        "According to the document [Result 1], machine learning is a subset of artificial intelligence. " +
        "The text states that it enables systems to learn from data without being explicitly programmed [Result 1]. " +
        "This directly addresses the query about machine learning.",
    },
  ]

  for (const scenario of scenarios) {
    const result = await evaluator.evaluate({
      userQuery: "What is machine learning?",
      toolCallHistory: scenario.toolHistory,
      draftAnswer: scenario.draftAnswer,
      iterationCount: 1,
      maxIterations: 5,
    })

    console.log(`Scenario: "${scenario.label}"`)
    console.log(`  Context Relevance: ${(result.contextRelevance * 100).toFixed(0)}%`)
    console.log(`  Faithfulness:      ${(result.faithfulness * 100).toFixed(0)}%`)
    console.log(`  Answer Relevance:  ${(result.answerRelevance * 100).toFixed(0)}%`)
    console.log(`  Overall Score:     ${(result.overallScore * 100).toFixed(0)}%`)
    console.log(
      `  Should Retry:      ${result.shouldRetry ? "YES ← will search again" : "NO ← proceed to answer"}`
    )
    console.log(`  Method:            ${result.evaluationMethod}`)
    if (result.retryReason) {
      console.log(`  Retry Reason:      ${result.retryReason}`)
    }
    console.log()
  }

  // ── Demo 2: Full agent run showing self-correction in action ──────────
  console.log("─".repeat(65))
  console.log("FULL AGENT RUN WITH SELF-CORRECTION\n")

  const result = await agentService.run(
    "What are the key concepts in machine learning?",
    "script-test-user"
  )

  console.log("STEPS (including quality checks):")
  result.steps.forEach(step => {
    const icon =
      step.toolUsed === "rag_search"
        ? "🔍"
        : step.toolUsed === "calculator"
          ? "🧮"
          : step.description.includes("Quality")
            ? "📊"
            : "💭"
    console.log(`  ${step.stepNumber}. ${icon} ${step.description} ` + `(${step.durationMs}ms)`)
  })

  console.log(`\nFINAL ANSWER:\n  ${result.finalAnswer}`)
  console.log(`\nMETRICS:`)
  console.log(`  Iterations:   ${result.iterationCount}`)
  console.log(`  Tokens used:  ${result.tokensUsed}`)
  console.log(`  Total time:   ${result.durationMs}ms`)
  console.log(`  Status:       ${result.status}`)

  console.log("\n✅ Self-correction demo complete!")

  await prisma.$disconnect()
  await redis.quit()
}

main().catch((error: unknown) => {
  console.error("❌ Test failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
