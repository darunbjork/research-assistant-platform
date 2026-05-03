-- This is an empty migration.
ALTER TABLE "DocumentChunk" ALTER COLUMN embedding TYPE vector(3072);