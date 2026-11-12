# ADR 0001 — Embedding at 768 dims with HNSW

**Status:** accepted (Phase 1, commits `065ca83`, `5e2bd0c`)

## Context

The original schema stored untyped `vector` columns and requested 3072-dim
embeddings. pgvector cannot build an HNSW index above 2,000 dimensions, so
vector search either could not be indexed or silently fell back to sequential
scan. The embedding dimension was also duplicated in code and schema (defect
D4/D5 in `docs/DEPLOY_READY_PLAN.md`).

## Decision

- Embed with `gemini-embedding-001` and `outputDimensionality = 768`.
- Column type is explicitly `vector(768)` with an HNSW cosine-distance index;
  keyword search stays a GIN/FTS index and the two results are fused with RRF.
- One baseline migration owns the schema (older `init.sql` was dropped).
  The move is documented in `docs/archive/VECTOR_DIMENSION_FIX.md`.

## Consequences

- HNSW is usable → indexed ANN search, predictable latency and cost.
- Storage per chunk drops ~4× versus 3072 dims.
- Existing embeddings from the 3072 era had to be re-generated once.
- Embedding model and column dimension are now coupled: changing either
  requires a new migration **and** a full re-embed of `document_chunks`.

## Revisit when

- pgvector supports larger HNSW indexes well, **or**
- a clearly better embedding model appears — then: new column + migration,
  backfill job, and an eval comparison before switching retrieval.
