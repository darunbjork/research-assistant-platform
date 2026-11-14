-- Day 4 follow-up: index for the daily global retention sweep.
-- purgeExpiredVoiceTranscripts() with no userId filter filters on
-- createdAt alone; without this index every sweep is a sequential scan.
CREATE INDEX "voice_transcripts_createdAt_idx" ON "voice_transcripts"("createdAt");
