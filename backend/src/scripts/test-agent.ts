/* eslint-disable no-console */
// backend/src/scripts/test-agent.ts
// End-to-end agent test — runs the full ReAct loop against real infrastructure.
// Run AFTER ingesting at least one document.
//
// Usage: npx ts-node src/scripts/test-agent.ts

import dotenv from "dotenv"
dotenv.config()

import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { GenerationService } from "../services/generation.service"
import { AgentService } from "../services/agent.service"
import redis from "../utils/redis"

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY

  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    console.error("❌ GEMINI_API_KEY not set")
    process.exit(1)
  }

  const prisma = new PrismaClient()
  const embeddingService = new EmbeddingService(apiKey, redis)
  const hybridSearch = new HybridSearchService(prisma, embeddingService)
  const generationService = new GenerationService(apiKey)
  const agentService = new AgentService(apiKey, hybridSearch, generationService)

  console.log("=".repeat(65))
  console.log("AGENT SERVICE — REACT LOOP TEST")
  console.log("=".repeat(65))

  const testQueries = [
    {
      query: "What is machine learning?",
      expected: "simple RAG query — 1-2 iterations",
    },
    {
      query: "What is 15% of 4.2 million?",
      expected: "calculator query — agent should use calculator tool",
    },
    {
      query:
        "What does the document say about learning from data, and how does that differ from traditional programming?",
      expected: "complex query — may need 2-3 search iterations",
    },
  ]

  for (const { query, expected } of testQueries) {
    console.log("\n" + "─".repeat(65))
    console.log(`QUERY:    "${query}"`)
    console.log(`EXPECTED: ${expected}`)
    console.log()

    const start = Date.now()
    const result = await agentService.run(query, "script-test-user")
    const total = Date.now() - start

    console.log(`ANSWER:`)
    console.log(`  ${result.finalAnswer}`)
    console.log()

    console.log(`STEPS (${result.steps.length}):`)
    result.steps.forEach(step => {
      console.log(
        `  ${step.stepNumber}. [${step.toolUsed ?? "internal"}] ` +
          `${step.description} (${step.durationMs}ms)`
      )
    })
    console.log()

    console.log(`METRICS:`)
    console.log(`  Iterations:  ${result.iterationCount}`)
    console.log(`  Citations:   ${result.citations.length}`)
    console.log(`  Tokens used: ${result.tokensUsed}`)
    console.log(`  Total time:  ${total}ms`)
    console.log(`  Status:      ${result.status}`)
  }

  console.log("\n" + "=".repeat(65))
  console.log("✅ Agent ReAct loop test complete!")

  await prisma.$disconnect()
  await redis.quit()
}

main().catch((error: unknown) => {
  console.error("❌ Test failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
