// Shared setup for integration tests (real Postgres + real Redis).
// Gemini is never called: tests either pass vectors directly or use a stub
// EmbeddingService that returns fakeVector().

import type { EmbeddingService } from "../services/embedding.service"

export const EMBEDDING_DIMENSIONS = 768

// Truncate every table the tests write to. CASCADE also clears any FK children.
export async function resetDb(): Promise<void> {
  const { prisma } = await import("../utils/prisma")
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "document_chunks", "documents", "agent_sessions", "users" RESTART IDENTITY CASCADE'
  )
}

// Deterministic 768-dim vector for a given seed — same seed, same vector,
// so tests are reproducible without calling the Gemini API.
export function fakeVector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(seed * 1.618 + i * 0.731))
}

export async function createUser(email: string): Promise<{ id: string; email: string }> {
  const { prisma } = await import("../utils/prisma")
  return prisma.user.create({
    data: { email, passwordHash: "integration-test-not-a-real-hash" },
  })
}

// A stub EmbeddingService: same shape as the real one, but every vector comes
// from fakeVector(). This is how "mock Gemini" is achieved in integration tests.
export function stubEmbeddingService(): EmbeddingService {
  return {
    embedText: async (): Promise<number[]> => fakeVector(1),
    embedBatch: async (texts: string[]): Promise<number[][]> =>
      texts.map((_, index) => fakeVector(index + 2)),
    getCacheStats: (): { hits: number; misses: number; hitRate: number } => ({
      hits: 0,
      misses: 0,
      hitRate: 0,
    }),
  } as unknown as EmbeddingService
}
