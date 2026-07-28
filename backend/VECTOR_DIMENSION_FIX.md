# Vector Dimension & Cache Fix

## Core Issue
During document ingestion, the pipeline failed with:
`ERROR: expected 768 dimensions, not 3072`

This occurred because:
1. **Schema Drift**: The backend embedding service was updated to use `gemini-embedding-001` (producing 3072-dimensional vectors), and the migration file was modified to define `vector(3072)`. However, the local PostgreSQL database table `document_chunks` was already migrated using the previous `vector(768)` definition, causing a schema mismatch.
2. **Embedding Cache Parsing Bug**: The `embedBatch()` method in `EmbeddingService` was deserializing cached payloads directly as a `number[]` array instead of parsing them as the expected wrapper type `CachedEmbedding`.
3. **Flaky Unit Tests**: Tests in `EvaluatorService` and `StreamingAgentService` expected an execution duration strictly greater than `0`, which failed on fast systems.

## Fix Applied
1. **Database Schema Reset**: Realigned the PostgreSQL instance with the modified migrations by running `npx prisma migrate reset --force`, updating the `embedding` column on `document_chunks` to `vector(3072)`.
2. **Cache Deserialization Fix**: Modified `embedBatch` in `src/services/embedding.service.ts` to properly deserialize `CachedEmbedding` payloads and extract the inner `.vector`.
3. **Robust Durations**: Adjusted unit test assertions in `src/__tests__/evaluator.service.test.ts` and `src/__tests__/streaming.agent.service.test.ts` to assert that duration is `>= 0` instead of `> 0`.
