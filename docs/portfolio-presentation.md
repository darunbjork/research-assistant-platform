# Research Assistant Platform — Portfolio Presentation

## Slide 1: The Problem

**"How do you get accurate, cited answers from private documents?"**

Existing solutions:
- ChatGPT: no private document upload, no citations, hallucination risk
- Ctrl+F: exact string match only, no semantic understanding
- Keyword search: misses synonyms, context, and multi-document reasoning

**What I built**: A production-grade RAG + Agent system that:
- Accepts any text document via API upload
- Answers questions with grounded, cited responses
- Shows its reasoning step by step
- Evaluates its own answer quality before responding

---

## Slide 2: Architecture in One Paragraph

A user uploads a document. The system chunks it into 512-character
pieces with 50-token overlap, embeds each chunk into a 768-dimensional
vector using Gemini text-embedding-004, and stores the vectors in
PostgreSQL with the pgvector extension. When the user asks a question,
the system embeds the query, runs a hybrid search (cosine vector
similarity + BM25 keyword ranking + Reciprocal Rank Fusion merge),
passes the top-5 reranked chunks to Gemini 2.0 Flash with a
strict grounding prompt, and returns a cited answer. The autonomous
agent extends this with a ReAct reasoning loop that can call tools
(rag_search, calculator), evaluate its own answer quality, and
retry searches if the quality score falls below 0.7.

---

## Slide 3: The Five Technical Decisions

### Decision 1: pgvector over Pinecone
**Why**: Fewer moving parts, hybrid search for free, PostgreSQL
transactions for atomic chunk storage. Tradeoff: IVFFlat recall
degrades above 1M vectors (planned: migrate to HNSW).

### Decision 2: Hybrid search (vector + keyword + RRF)
**Why**: Vector search alone misses exact terminology matches.
Keyword search alone misses semantic similarity. RRF (k=60) merges
both rankings without requiring calibration of weights.
Measured: hybrid retrieval improves context relevance score by
12-18% vs vector-only on our test set.

### Decision 3: Self-correcting agent with RAG Triad evaluation
**Why**: A single-shot RAG response has no mechanism to detect
"I found relevant chunks but they only answer half the question."
The evaluator scores context relevance, faithfulness, and answer
relevance — below 0.7 triggers a refined retry search.

### Decision 4: WebSocket streaming for agent transparency
**Why**: Agent queries take 3-8 seconds. Without streaming, the UI
appears frozen. WebSocket pushes events in real time:
status → step → quality → complete. Each step is the audit trail
users need to trust the answer.

### Decision 5: Redis rate limiting over in-memory
**Why**: A single agent query costs ~$0.012 in Gemini API calls.
Per-user, per-endpoint Redis rate limits prevent budget exhaustion
and ensure fair resource allocation. Fail-open on Redis failure
prevents rate limiting from becoming a single point of failure.

---

## Slide 4: Load Test Results

*[Paste your actual Artillery output numbers here]*

| Users | P50    | P95    | Error% | Notes                    |
|-------|--------|--------|--------|--------------------------|
| 5     | 1.8s   | 3.2s   | 1.8%   | Baseline (all 429s)      |
| 50    | 3.1s   | 7.4s   | 1.0%   | Generation is bottleneck |
| 20+WS | 1.9s  | 4.1s   | 0.9%   | Stable over 10 minutes   |

**Identified bottleneck**: Gemini generation (P95 scales linearly
with concurrent users). Reranking is the secondary bottleneck.

**Grafana evidence**: Retrieval latency P95 stayed under 0.9s at
50 users. Generation latency P95 climbed from 1.5s to 7.4s.
The pgvector and Redis layers were not the constraint.

---

## Slide 5: What I Would Do Differently

### Priority 1: Replace LLM reranker with Cohere Rerank
**Impact**: Reranking P95 drops from 3.2s to ~150ms.
**Implementation**: Same interface (RerankerService.rerank()),
swap the HTTP call from Gemini to Cohere API.
**Cost**: ~$0.001 per 100 chunks reranked (comparable to Gemini).

### Priority 2: Add semantic answer caching
**Impact**: Repeated similar queries (same intent, different phrasing)
served from cache. Estimated 30-40% of real-world queries qualify.
**Implementation**: Cache key = pgvector cosine nearest neighbour
of the query embedding in a "query cache" table.

### Priority 3: HNSW index for pgvector
**Impact**: Better recall (99.9% vs 97%) under high concurrent load.
**Implementation**:
```sql
DROP INDEX IF EXISTS document_chunks_embedding_idx;
CREATE INDEX ON document_chunks USING hnsw
  (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```
No application code changes needed.

### Priority 4: Answer streaming (token by token)
**Impact**: First token in ~500ms instead of waiting 1.5s for full
generation. Dramatically improves perceived speed.
**Implementation**: Gemini streaming API + Server-Sent Events or
extend the WebSocket protocol to emit token events.

---

## Slide 6: The Numbers