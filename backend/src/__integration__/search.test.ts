// backend/src/__integration__/search.test.ts
//
// Integration tests against a REAL Postgres (pgvector + FTS) and REAL Redis.
// Gemini is never called — vectors come from fakeVector() via a stub
// EmbeddingService.
//
// These tests exist because unit tests mock Prisma, so they cannot catch:
//   - D1: raw SQL using PascalCase table names that don't exist
//   - D3: the documentIds branch leaking another user's chunks

import type { EmbeddingService } from "../services/embedding.service"
import { prisma } from "../utils/prisma"
import { checkRedisHealth } from "../utils/redis"
import { ChunkRepository, type ChunkToStore } from "../repositories/chunk.repository"
import { VectorSearchService } from "../services/vector.search.service"
import { KeywordSearchService } from "../services/keyword.search.service"
import { resetDb, fakeVector, createUser, stubEmbeddingService } from "./helpers"

jest.setTimeout(30_000)

const CHUNK_TEXT = "Machine learning enables systems to learn from data."

describe("search integration (real Postgres + Redis)", () => {
  let embedding: EmbeddingService
  let chunkRepo: ChunkRepository
  let vectorSearch: VectorSearchService
  let keywordSearch: KeywordSearchService

  let userA: { id: string; email: string }
  let userB: { id: string; email: string }
  let docA: { id: string }

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for integration tests")
    }
  })

  beforeEach(async () => {
    await expect(checkRedisHealth()).resolves.toBe("ok")

    await resetDb()

    embedding = stubEmbeddingService()
    chunkRepo = new ChunkRepository(prisma)
    vectorSearch = new VectorSearchService(prisma)
    keywordSearch = new KeywordSearchService(prisma)

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    userA = await createUser(`user-a-${suffix}@test.local`)
    userB = await createUser(`user-b-${suffix}@test.local`)

    const doc = await prisma.document.create({
      data: {
        name: "ml-intro.txt",
        content: CHUNK_TEXT,
        mimeType: "text/plain",
        sizeBytes: CHUNK_TEXT.length,
        userId: userA.id,
      },
    })
    docA = { id: doc.id }

    const chunk: ChunkToStore = {
      content: CHUNK_TEXT,
      chunkIndex: 0,
      tokenCount: 10,
      embedding: fakeVector(7),
      metadata: {
        source: "ml-intro.txt",
        chunkingStrategy: "recursive",
        characterCount: CHUNK_TEXT.length,
      },
    }
    const stored = await chunkRepo.storeMany(docA.id, [chunk])
    expect(stored).toBe(1)
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  // ── Positive: the owner finds their own chunk ──────────────────────────
  it("vector search returns A's chunk when searching as A", async () => {
    const queryVector = await embedding.embedText("machine learning", "RETRIEVAL_QUERY")
    const results = await vectorSearch.search(queryVector, { userId: userA.id })

    expect(results).toHaveLength(1)
    expect(results[0]?.chunk.content).toBe(CHUNK_TEXT)
    expect(results[0]?.chunk.documentId).toBe(docA.id)
  })

  it("keyword search finds A's chunk when searching as A", async () => {
    const results = await keywordSearch.search("machine learning", { userId: userA.id })

    expect(results).toHaveLength(1)
    expect(results[0]?.chunk.content).toBe(CHUNK_TEXT)
    expect(results[0]?.chunk.documentId).toBe(docA.id)
  })

  // ── Cross-tenant: B must never see A's chunks ──────────────────────────
  it("vector search returns 0 results for B even with A's documentId", async () => {
    const queryVector = await embedding.embedText("machine learning", "RETRIEVAL_QUERY")
    const results = await vectorSearch.search(queryVector, {
      userId: userB.id,
      documentIds: [docA.id],
    })

    expect(results).toHaveLength(0)
  })

  it("keyword search returns 0 results for B even with A's documentId", async () => {
    const results = await keywordSearch.search("machine learning", {
      userId: userB.id,
      documentIds: [docA.id],
    })

    expect(results).toHaveLength(0)
  })

  it("vector search returns 0 results for B with no documentIds filter", async () => {
    const queryVector = await embedding.embedText("machine learning", "RETRIEVAL_QUERY")
    const results = await vectorSearch.search(queryVector, { userId: userB.id })

    expect(results).toHaveLength(0)
  })

  it("keyword search returns 0 results for B with no documentIds filter", async () => {
    const results = await keywordSearch.search("machine learning", { userId: userB.id })

    expect(results).toHaveLength(0)
  })

  // ── The HNSW index must actually be usable ─────────────────────────────
  it("EXPLAIN of the vector query uses document_chunks_embedding_hnsw_idx", async () => {
    const userId = userA.id
    const documentIds: string[] = []
    const vectorLiteral = `[${fakeVector(7).join(",")}]`

    // SET and EXPLAIN must run in one transaction: SET is transactional in
    // Postgres, and a prepared statement may not contain multiple commands.
    // enable_sort=off: with 1-2 rows the planner prefers "join then sort",
    // which hides the index. Disabling sort forces the ordered HNSW scan,
    // which is what production (large tables) does anyway.
    const plans = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET enable_seqscan = off`
      await tx.$executeRaw`SET enable_sort = off`
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN
        SELECT dc.id
        FROM "document_chunks" dc
        JOIN "documents" d ON d.id = dc."documentId"
        WHERE d."userId" = ${userId}
          AND (cardinality(${documentIds}::text[]) = 0
               OR dc."documentId" = ANY(${documentIds}::text[]))
        ORDER BY dc.embedding <=> ${vectorLiteral}::vector
        LIMIT 10
      `
    })

    const plan = plans.map(row => row["QUERY PLAN"]).join("\n")
    expect(plan).toContain("document_chunks_embedding_hnsw_idx")
  })
})
