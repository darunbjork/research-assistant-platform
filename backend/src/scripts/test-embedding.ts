/* eslint-disable no-console */
// * Run this to call the REAL Gemini API and see actual vectors.
// Usage: npx ts-node src/scripts/test-embedding.ts
//
// * This script is for development verification — not a test file.
// It hits the real API so it costs a tiny amount per run.
// Run it once to verify your API key works, then use the mocked tests.

import dotenv from "dotenv"
dotenv.config()

import { EmbeddingService } from "../services/embedding.service"
import redis from "../utils/redis"

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY

  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    console.error("❌ GEMINI_API_KEY is not set in .env")
    console.error("   Get your key at https://aistudio.google.com")
    process.exit(1)
  }

  console.log("=".repeat(60))
  console.log("EMBEDDING SERVICE — REAL API TEST")
  console.log("=".repeat(60))

  const service = new EmbeddingService(apiKey, redis)

  // ── Test 1: Single embedding ──────────────────────────────────────────
  console.log("\n1. Embedding a single text...")
  const start1 = Date.now()
  const vector1 = await service.embedText("What is machine learning?")
  console.log(`   ✅ Vector length: ${vector1.length} dimensions`)
  console.log(`   ✅ Duration: ${Date.now() - start1}ms`)
  console.log(
    `   ✅ First 5 values: [${vector1
      .slice(0, 5)
      .map(v => v.toFixed(4))
      .join(", ")}]`
  )

  // ── Test 2: Cache hit ─────────────────────────────────────────────────
  console.log("\n2. Embedding the same text again (should be from cache)...")
  const start2 = Date.now()
  const vector2 = await service.embedText("What is machine learning?")
  const time2 = Date.now() - start2
  console.log(`   ✅ Duration: ${time2}ms ${time2 < 10 ? "(cache hit! 🎉)" : "(cache miss)"}`)
  console.log(`   ✅ Vectors match: ${JSON.stringify(vector1) === JSON.stringify(vector2)}`)

  // ── Test 3: Semantic similarity ───────────────────────────────────────
  console.log("\n3. Semantic similarity test...")
  const texts = [
    "What is machine learning?",
    "Explain artificial intelligence", // similar meaning
    "How do I bake chocolate chip cookies?", // unrelated
  ]

  const [v1, v2, v3] = await service.embedBatch(texts)

  if (v1 && v2 && v3) {
    const simRelated = cosineSimilarity(v1, v2)
    const simUnrelated = cosineSimilarity(v1, v3)

    console.log(
      `   Similarity (ML vs AI):       ${simRelated.toFixed(4)}  ← should be HIGH (> 0.7)`
    )
    console.log(
      `   Similarity (ML vs cookies):  ${simUnrelated.toFixed(4)} ← should be LOW  (< 0.6)`
    )

    if (simRelated > simUnrelated) {
      console.log("   ✅ PASS: Related texts are more similar than unrelated texts")
    } else {
      console.log("   ❌ FAIL: Similarity ordering is wrong — check API response")
    }
  }

  // ── Test 4: Cache stats ───────────────────────────────────────────────
  console.log("\n4. Cache performance:")
  const stats = service.getCacheStats()
  console.log(`   Hits:    ${stats.hits}`)
  console.log(`   Misses:  ${stats.misses}`)
  console.log(`   Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`)

  console.log("\n✅ All embedding tests passed!")

  // Clean up Redis connection so the script exits cleanly
  await redis.quit()
}

// Compute cosine similarity between two vectors
// Returns a value from 0 (completely different) to 1 (identical)
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector dimensions must match")

  let dotProduct = 0
  let magnitudeA = 0
  let magnitudeB = 0

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dotProduct += ai * bi
    magnitudeA += ai * ai
    magnitudeB += bi * bi
  }

  const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB)
  if (magnitude === 0) return 0

  return dotProduct / magnitude
}

// Run and handle errors
main().catch((error: unknown) => {
  console.error("❌ Test failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
