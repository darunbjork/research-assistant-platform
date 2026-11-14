// backend/src/__integration__/schema.test.ts
//
// Runs AFTER `prisma migrate deploy` (CI does deploy → test:integration),
// so these assertions prove the deployed database — not just schema.prisma —
// carries the indexes the code relies on.
//
// The HNSW case matters most: Prisma cannot model HNSW indexes (the
// `embedding` column is `Unsupported("vector(768)")`), so
// `prisma migrate diff` proposes dropping it and a careless `migrate dev`
// could generate a `DROP INDEX`. Losing it would silently degrade vector
// search from an index scan to a sequential scan — no error, just latency.
// The CI guard rejects DROP INDEX in migrations; this test catches the
// other direction (index missing from the deployed database).

import { prisma } from "../utils/prisma"

jest.setTimeout(30_000)

async function indexNames(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    "SELECT indexname FROM pg_indexes WHERE tablename = $1",
    table
  )
  return rows.map(row => row.indexname)
}

describe("deployed schema (post migrate deploy)", () => {
  it("keeps the HNSW index on document_chunks.embedding", async () => {
    const names = await indexNames("document_chunks")
    expect(names).toContain("document_chunks_embedding_hnsw_idx")

    const rows = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'document_chunks_embedding_hnsw_idx'"
    )
    expect(rows[0]?.indexdef).toContain("USING hnsw")
    expect(rows[0]?.indexdef).toContain("vector_cosine_ops")
  })

  it("keeps every voice_transcripts index, including the retention sweep", async () => {
    const names = await indexNames("voice_transcripts")
    expect(names).toEqual(
      expect.arrayContaining([
        "voice_transcripts_userId_createdAt_idx",
        "voice_transcripts_sessionId_idx",
        "voice_transcripts_createdAt_idx",
      ])
    )
  })
})
