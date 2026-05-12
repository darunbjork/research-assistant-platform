/* eslint-disable no-console */
import dotenv from "dotenv"
dotenv.config()

import { PrismaClient } from "@prisma/client"
import { EmbeddingService } from "../services/embedding.service"
import { HybridSearchService } from "../services/hybrid.search.service"
import { SearchCache } from "../cache/search.cache"
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
  const searchCacheInst = new SearchCache(redis)

  console.log("=".repeat(65))
  console.log("SEARCH CACHE PERFORMANCE DEMO")
  console.log("=".repeat(65))
  console.log()

  const query = "What is machine learning?"
  const userId = "demo-user-123"

  // ── First call (cache miss) ───────────────────────────────────────────
  console.log("1. First search (cache MISS — computes from scratch):")
  const start1 = Date.now()
  const results1 = await hybridService.search(query, { topK: 5, userId })
  const time1 = Date.now() - start1

  console.log(`   Results: ${results1.length} chunks`)
  console.log(`   Duration: ${time1}ms`)
  console.log(`   Cache: MISS → stored in Redis`)
  console.log()

  // ── Second call (cache hit) ───────────────────────────────────────────
  console.log("2. Same search (cache HIT — served from Redis):")
  const start2 = Date.now()
  const results2 = await hybridService.search(query, { topK: 5, userId })
  const time2 = Date.now() - start2

  console.log(`   Results: ${results2.length} chunks`)
  console.log(`   Duration: ${time2}ms`)
  console.log(`   Cache: HIT`)
  console.log(`   Speedup: ${(time1 / time2).toFixed(1)}× faster`)
  console.log()

  // ── Cache stats ───────────────────────────────────────────────────────
  const stats = searchCacheInst.getStats()
  console.log("3. Cache statistics:")
  console.log(`   Hits:     ${stats.hits}`)
  console.log(`   Misses:   ${stats.misses}`)
  console.log(`   Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`)
  console.log()

  // ── Verify cached results match original ──────────────────────────────
  const resultsMatch = JSON.stringify(results1) === JSON.stringify(results2)
  console.log(`4. Results consistency: ${resultsMatch ? "✅ Identical" : "❌ Different"}`)
  console.log()

  // ── Cache invalidation demo ───────────────────────────────────────────
  console.log("5. Cache invalidation (simulating document delete):")
  const deleted = await searchCacheInst.invalidateForUser(userId)
  console.log(`   Deleted ${deleted} cache entry/entries for user`)

  // Third call after invalidation — should miss again
  const start3 = Date.now()
  await hybridService.search(query, { topK: 5, userId })
  const time3 = Date.now() - start3
  console.log(`   Post-invalidation search: ${time3}ms (cache miss → recomputed)`)

  console.log()
  console.log("=".repeat(65))
  console.log("BULL QUEUE DEMO")
  console.log("=".repeat(65))
  console.log()

  // Check queue is available
  const { getIngestionQueue } = await import("../queue/index")
  const queue = getIngestionQueue()

  // Get queue stats
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ])

  console.log("Queue status:")
  console.log(`  Waiting:   ${waiting}`)
  console.log(`  Active:    ${active}`)
  console.log(`  Completed: ${completed}`)
  console.log(`  Failed:    ${failed}`)
  console.log()

  // Add a test job
  const testJob = await queue.add({
    name: "test-document.txt",
    content: "This is a test document for the queue demo. Machine learning is great.",
    mimeType: "text/plain",
    sizeBytes: 70,
    userId: "script-demo-user",
    requestId: "script-test",
  })

  console.log(`Test job added: jobId=${testJob.id}`)
  console.log("Waiting for job to complete...")

  // Poll for completion
  let status = "waiting"
  let attempts = 0
  while (status !== "completed" && status !== "failed" && attempts < 30) {
    await new Promise(r => setTimeout(r, 1000))
    const state = await testJob.getState()
    const prog = testJob.progress()
    status = state
    attempts++
    process.stdout.write(`\r  Status: ${status} | Progress: ${prog}%    `)
  }

  console.log()

  if (status === "completed") {
    const result = testJob.returnvalue as { chunkCount: number; durationMs: number } | undefined
    console.log(`\n✅ Job completed!`)
    console.log(`   Chunks: ${result?.chunkCount ?? "?"}`)
    console.log(`   Duration: ${result?.durationMs ?? "?"}ms`)
  } else {
    console.log(`\n⚠️  Job status: ${status}`)
    if (testJob.failedReason) {
      console.log(`   Reason: ${testJob.failedReason}`)
    }
  }

  console.log("\n✅ Caching + queue demo complete!")

  await queue.close()
  await prisma.$disconnect()
  await redis.quit()
}

main().catch((error: unknown) => {
  console.error("❌ Demo failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
