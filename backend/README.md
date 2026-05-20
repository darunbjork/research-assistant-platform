# Research Assistant Platform 🤖

[![CI](https://github.com/darunbjork/research-assistant-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/darunbjork/research-assistant-platform/actions)
[![Coverage](https://img.shields.io/badge/coverage-82%25-green)](./coverage)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](./tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-640%2B-brightgreen)](./src/__tests__)

A production-grade **Retrieval-Augmented Generation (RAG) + AI Agent**
platform. Upload documents, get grounded, cited answers with full
reasoning transparency.

## What Makes This Production-Grade

| Feature                  | Implementation                                |
|--------------------------|-----------------------------------------------|
| **Hybrid search**        | pgvector cosine + tsvector BM25 + RRF merge   |
| **Self-correcting agent**| ReAct loop + RAG Triad quality evaluation     |
| **Real-time streaming**  | WebSocket agent steps as they happen          |
| **Zero hallucination**   | 3-layer: system prompt + faithfulness eval + citations |
| **Performance**          | Redis embedding cache (24h) + search cache (5min) |
| **Rate limiting**        | Per-user Redis INCR/EXPIRE, fail-open         |
| **Observability**        | Prometheus + Grafana (12 panels) + OTel traces |
| **Load tested**          | Artillery 6 scenarios, bottleneck identified   |
| **Test coverage**        | 640+ Jest tests, 82% line coverage, CI enforced |
| **Type safety**          | TypeScript strict, zero `any` in production   |

## Tech Stack

**Backend**: Node.js 20 · Express · TypeScript (strict) · Prisma  
**AI**: Gemini text-embedding-004 · Gemini 2.0 Flash  
**Storage**: PostgreSQL 16 + pgvector · Redis 7  
**Queue**: Bull Queue (async ingestion)  
**Observability**: Prometheus · Grafana · OpenTelemetry · Jaeger  
**Frontend**: React 18 · Vite · Tailwind CSS  
**Testing**: Jest · Artillery · 640+ tests · 82% coverage  
**CI/CD**: GitHub Actions · 9-step pipeline  

## Quick Start

```bash
# Prerequisites: Docker, Node.js 20

# 1. Clone and install
git clone https://github.com/darunbjork/research-assistant-platform
cd research-assistant-platform/backend
npm install

# 2. Start infrastructure
docker compose up -d

# 3. Configure environment
cp .env.example .env
# Fill in GEMINI_API_KEY (get from https://aistudio.google.com)

# 4. Run migrations and start
npx prisma migrate dev
npm run dev

# 5. Open the frontend
cd ../frontend && npm install && npm run dev
# → http://localhost:5173
```

## Architecture

See [docs/architecture.md](./docs/architecture.md) for:
- Full system diagram (Mermaid C4 + sequence diagrams)
- 4 Architecture Decision Records (ADRs)
- Request lifecycle end-to-end walkthrough
- Load test results and identified bottlenecks
- Known limitations and planned improvements

## Load Test Results

Tested with Artillery at 50 concurrent users:

| Stage       | P50    | P95    | Bottleneck?     |
|-------------|--------|--------|-----------------|
| Embedding   | 4ms    | 9ms    | ✅ (cached)     |
| Vector search| 12ms  | 28ms   | ✅              |
| Reranking   | 820ms  | 3.2s   | ⚠️ Secondary    |
| Generation  | 1.5s   | 7.4s   | ❌ Primary      |

**Fix planned**: Cohere Rerank (150ms) + generation timeout with fallback.

## API Documentation

Start the server and visit: `http://localhost:3001/api/docs`

Key endpoints:
- `POST /api/v1/documents/ingest` — async document upload (returns jobId)
- `POST /api/v1/rag/query` — grounded RAG answer
- `POST /api/v1/agent/chat` — autonomous agent with reasoning steps
- `POST /api/v1/eval/score` — RAG Triad quality evaluation
- `GET  /metrics` — Prometheus metrics
- `WS   /ws/agent` — real-time agent streaming