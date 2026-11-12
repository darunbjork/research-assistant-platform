-- Day 3b: voice transcripts (additive only — no existing tables/columns
-- are altered; vector columns on document_chunks are untouched).
-- TEXT ONLY: raw audio is never persisted.

-- CreateTable
CREATE TABLE "voice_transcripts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_transcripts_userId_createdAt_idx" ON "voice_transcripts"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "voice_transcripts_sessionId_idx" ON "voice_transcripts"("sessionId");

-- AddForeignKey (cascade on user delete, like every other user-owned table)
ALTER TABLE "voice_transcripts" ADD CONSTRAINT "voice_transcripts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
