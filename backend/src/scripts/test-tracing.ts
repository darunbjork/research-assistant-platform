/* eslint-disable no-console */
// backend/src/scripts/test-tracing.ts
// Demonstrates OpenTelemetry tracing by running a traced RAG query
// and printing the resulting spans.
//
// Usage: npx ts-node -r ./src/telemetry/tracer src/scripts/test-tracing.ts

import "../telemetry/tracer" // Must be first
import dotenv from "dotenv"
dotenv.config()

import { getTracer } from "../telemetry/tracer"
import { withSpan, LLM_ATTRS, RAG_ATTRS } from "../telemetry/spans"

async function main(): Promise<void> {
  console.log("=".repeat(65))
  console.log("OPENTELEMETRY TRACING DEMO")
  console.log("=".repeat(65))
  console.log()
  console.log("This script creates a sample traced pipeline.")
  console.log("Spans will appear below (ConsoleSpanExporter format).")
  console.log()
  console.log("To view traces in Jaeger:")
  console.log("  1. docker compose -f docker-compose.observability.yml up -d")
  console.log("  2. Set OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 in .env")
  console.log("  3. Restart the server and run queries")
  console.log("  4. Open http://localhost:16686 → select 'research-assistant-backend'")
  console.log()
  console.log("─".repeat(65))
  console.log("SAMPLE SPANS:")
  console.log("─".repeat(65))

  const tracer = getTracer("demo-script")

  // Simulate a traced RAG pipeline
  await withSpan(tracer, "demo.ragPipeline", async rootSpan => {
    rootSpan.setAttribute(RAG_ATTRS.QUERY, "What is machine learning?")

    // Simulate embedding
    await withSpan(tracer, "demo.embedding.embedText", async span => {
      span.setAttribute(LLM_ATTRS.SYSTEM, "google_gemini")
      span.setAttribute(LLM_ATTRS.MODEL, "text-embedding-004")
      span.setAttribute(LLM_ATTRS.OPERATION, "embed")
      span.setAttribute(RAG_ATTRS.CACHE_HIT, false)

      // Simulate async work
      await new Promise(r => setTimeout(r, 50))

      span.setAttribute("embedding.dimensions", 768)
      span.setAttribute(LLM_ATTRS.OUTPUT_TOKENS, 768)
    })

    // Simulate hybrid search
    await withSpan(tracer, "demo.retrieval.hybridSearch", async span => {
      span.setAttribute(RAG_ATTRS.STRATEGY, "hybrid")
      span.setAttribute("db.system", "postgresql")

      // Child: vector search
      await withSpan(tracer, "demo.retrieval.vectorSearch", async vs => {
        vs.setAttribute("db.operation", "cosine_similarity")
        await new Promise(r => setTimeout(r, 20))
        vs.setAttribute(RAG_ATTRS.CHUNKS_RETRIEVED, 10)
      })

      // Child: keyword search
      await withSpan(tracer, "demo.retrieval.keywordSearch", async ks => {
        ks.setAttribute("db.operation", "tsvector_search")
        await new Promise(r => setTimeout(r, 8))
        ks.setAttribute(RAG_ATTRS.CHUNKS_RETRIEVED, 8)
      })

      span.setAttribute(RAG_ATTRS.CHUNKS_RETRIEVED, 10)
    })

    // Simulate generation
    await withSpan(tracer, "demo.generation.generate", async span => {
      span.setAttribute(LLM_ATTRS.MODEL, "gemini-2.0-flash")
      span.setAttribute(LLM_ATTRS.TEMPERATURE, 0.1)
      span.setAttribute(RAG_ATTRS.CHUNKS_USED, 5)

      await new Promise(r => setTimeout(r, 120))

      span.setAttribute(LLM_ATTRS.TOTAL_TOKENS, 623)
      span.setAttribute(LLM_ATTRS.INPUT_TOKENS, 436)
      span.setAttribute(LLM_ATTRS.OUTPUT_TOKENS, 187)
    })

    rootSpan.setAttribute(LLM_ATTRS.TOTAL_TOKENS, 623)
  })

  // Give the exporter time to flush
  await new Promise(r => setTimeout(r, 500))

  console.log()
  console.log("─".repeat(65))
  console.log("ATTRIBUTE REFERENCE (set on every LLM span):")
  console.log()
  Object.entries(LLM_ATTRS).forEach(([name, value]) => {
    console.log(`  ${name.padEnd(18)}: "${value}"`)
  })
  console.log()
  Object.entries(RAG_ATTRS).forEach(([name, value]) => {
    console.log(`  ${name.padEnd(18)}: "${value}"`)
  })
  console.log()
  console.log("✅ Tracing demo complete!")
  console.log()
  console.log("NEXT STEPS:")
  console.log("  1. Run the backend: npm run dev")
  console.log("  2. Make a RAG query from the frontend")
  console.log("  3. Watch the terminal for ConsoleSpanExporter output")
  console.log("     OR start Jaeger and see visual waterfall diagrams")
}

main().catch((error: unknown) => {
  console.error("❌ Demo failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
