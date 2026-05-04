-- backend/src/database/migrations/add_vector_index.sql
-- Creates a pgvector IVFFlat index for fast cosine similarity search.
--
-- WHY THIS IS NOT IN PRISMA MIGRATE:
-- Prisma does not support pgvector index syntax natively.
-- We manage this migration manually using raw SQL.
-- Run it ONCE after you have ingested your first documents.
--
-- WHEN TO RUN THIS:
-- Run it when you have at least 1000 chunk rows.
-- Below 1000 rows: sequential scan is faster than an index.
-- Above 10,000 rows: the index provides 10-50x speedup.
--
-- HOW IVFFLAT WORKS:
-- IVFFlat = Inverted File Flat
-- 1. During index build: group all vectors into N "lists" (clusters)
-- 2. During search: find the closest cluster(s), search only those
-- "lists = 100" means 100 clusters.
-- Rule of thumb: lists ≈ sqrt(total_rows)
-- For 10,000 rows: lists = 100
-- For 1,000,000 rows: lists = 1000
--
-- probes = 10: at search time, check 10 of the 100 lists.
-- Higher probes = better recall, slower search.
-- probes = 10 gives ~95% recall vs exact search.

-- Create the index (only if it does not already exist)
CREATE INDEX IF NOT EXISTS idx_document_chunk_embedding
ON "DocumentChunk"
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Set the probe count for this session (tune this at query time)
-- This tells pgvector how many clusters to search.
-- Higher = more accurate, slower. Lower = faster, less accurate.
SET ivfflat.probes = 10;

-- Verify the index was created
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'DocumentChunk'
  AND indexname = 'idx_document_chunk_embedding';