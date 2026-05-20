# Interview Preparation — Research Assistant Platform

## The 60-Second Elevator Pitch

"I built a production-grade RAG system in TypeScript with a self-correcting
autonomous agent. Users upload documents, and the system answers questions
with grounded, cited responses. The pipeline has five stages: embedding
with Gemini, hybrid search using pgvector plus PostgreSQL full-text search
merged with Reciprocal Rank Fusion, cross-encoder reranking, grounded
generation with an anti-hallucination prompt, and a self-evaluation step
that scores the answer quality and triggers a retry if it falls below
seventy percent. The system has 640 unit tests at 82% coverage, WebSocket
streaming for real-time agent transparency, Redis caching for repeated
queries, async document ingestion via Bull Queue, per-user rate limiting,
and a Grafana dashboard with 12 panels including RAG Triad quality scores.
Load testing with Artillery showed generation is the primary bottleneck
at 50 concurrent users."

---

## Common Interview Questions and Your Answers

### Q: "What is RAG and why did you build it this way?"

A: RAG — Retrieval-Augmented Generation — solves the hallucination
problem in LLMs by grounding the answer in retrieved evidence. Instead
of relying on the model's training data, you retrieve relevant chunks
from a document store and pass them as context. The model can only
use what is in the context window.

I built it with hybrid search (vector + keyword) because pure vector
search misses exact terminology — if a document says "Q3 EBITDA" and
the user asks "third quarter earnings before interest", vector search
works but keyword search fails. If they ask "EBITDA" exactly, keyword
search finds it but a vector query about "profitability" might miss it.
RRF combines both without manual weight tuning.

---

### Q: "Why TypeScript instead of Python?"

A: Python is dominant in ML research. TypeScript is dominant in
production web systems. This project is about the engineering of
production AI systems, not research — so TypeScript is the right
choice for: type safety, Express ecosystem, shared types between
frontend and backend, and the job market I'm targeting.

The AI components (Gemini API, pgvector queries) are HTTP calls and
SQL — language-agnostic. The same architecture in Python would use
FastAPI + SQLAlchemy + asyncpg — the concepts transfer directly.

---

### Q: "How did you prevent hallucination?"

A: Three layers.

Layer 1: The system prompt explicitly forbids the model from using
knowledge outside the retrieved context:
"You MUST only use information from the context below.
If the context does not contain the answer, say so explicitly."

Layer 2: The faithfulness dimension of the RAG Triad evaluator.
After the draft answer is generated, a separate Gemini call reads
the answer and context together and scores whether every claim
in the answer is supported. Below 0.7, the agent retries.

Layer 3: Citation requirements. The synthesis prompt requires
[Evidence N] references for every factual claim. An answer without
citations is rejected by the evaluation step.

---

### Q: "How does your agent know when to stop searching?"

A: The quality threshold at 0.7. After each tool call, the agent
generates a draft answer and evaluates it using the RAG Triad.

If the overall score (average of context relevance, faithfulness,
and answer relevance) is 0.7 or higher, the agent exits the loop
and synthesises the final answer.

If below 0.7, the evaluator provides a suggestedQuery — a refined
search query that might find the missing information. The agent uses
this for the next rag_search call instead of repeating the same query.

The maximum iteration cap of 5 is a safety net — even if quality
never reaches 0.7, the agent exits after 5 iterations.

---

### Q: "Tell me about a bug you fixed."

A: The most interesting bug was in the cache invalidation.
Originally I used Redis KEYS to find all cache entries for a user
when they deleted a document. In development with 10 cache entries,
this worked fine. The issue: Redis KEYS is a blocking O(N) operation
that scans every key in the database. With a production Redis instance
holding 100,000 keys, KEYS would block all other Redis operations
for seconds — effectively a self-inflicted denial of service.

I replaced it with Redis SCAN, which is iterative and non-blocking.
SCAN uses a cursor and returns a small batch of matching keys per
call. It takes more round trips but each round trip is fast and
does not block other clients.

The fix: a do-while loop that calls SCAN with cursor="0", collects
matching keys into an array, and continues until the cursor returns
to "0" (meaning the full scan is complete). Then DELETE all collected
keys in a single DEL call.

---

### Q: "What is your test strategy?"

A: Three layers.

Unit tests (640+ tests, 82% coverage): every service is tested with
mocked dependencies. All Gemini API calls use jest.spyOn(global, "fetch")
with hand-crafted response objects. No real API calls in CI — this
keeps the test suite fast (15 seconds) and offline-capable.

A shared mock factory library (src/__tests__/helpers/mock-factories.ts)
provides consistent mocks for all 24 test files. When an interface
changes, I update one factory, not 24 test files.

The CI pipeline enforces the 80% coverage threshold — it fails
if coverage drops below 80%. This prevents "under deadline" shortcuts
from leaving the codebase untested.

Integration testing was done manually with the Artillery load test
suite, which catches concurrency bugs that unit tests cannot simulate.

---

### Q: "How would you scale this to 10,000 users?"

A: Five changes.

1. Horizontal scaling: the API server is stateless — run 10 instances
behind a load balancer. Redis is already shared across instances for
rate limiting and caching.

2. Read replicas: add 2 PostgreSQL read replicas for vector search.
All writes go to primary, all vector searches go to replicas.

3. Cohere Rerank: replace the Gemini-based reranker. Reranking is
the bottleneck at 50 users (P95=3.2s). Cohere Rerank is ~150ms P95
and scales independently.

4. Answer caching: semantic cache with pgvector. Store (query_embedding, answer)
pairs. Cache hits for semantically similar queries within cosine distance 0.02.

5. Redis Sentinel or Cluster: the current single-node Redis is a
single point of failure. Sentinel provides automatic failover,
Cluster provides horizontal sharding for >100GB data.

---

## GitHub Repository Talking Points

When sharing your GitHub link in an interview:

1. Point to the CI badge first:
   "The green badge means the 9-step pipeline passed on this commit."

2. Show the test count:
   "640 tests, 82% coverage. The threshold is enforced in CI."

3. Open the architecture.md:
   "Here are the four ADRs — the decisions I made and why."

4. Show a test file:
   "Here is how I mock the Gemini API — jest.spyOn on global fetch."

5. Show the Grafana dashboard screenshot (add one to docs/):
   "This is what the system looks like under load. P95 retrieval is
   here, faithfulness score is here."