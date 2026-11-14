# ResearchBot — Production-Grade Agentic RAG Platform
<img width="1440" height="900" alt="Screenshot 2026-07-28 at 17 40 06" src="https://github.com/user-attachments/assets/8b4e9650-448e-468b-a9be-048abcfb7362" />
<img width="1440" height="900" alt="Screenshot 2026-07-28 at 17 40 22" src="https://github.com/user-attachments/assets/1ad075fb-78ba-4a57-9dc3-4b088823ea4d" />


---

## 📌 Overview

**ResearchBot** is a full-stack, enterprise-grade Retrieval-Augmented Generation (RAG) and Agentic platform. Built with Node.js, Express, TypeScript, React, PostgreSQL (`pgvector`), Redis, and Google Gemini API, it provides intelligent document search, cross-encoder reranking, and real-time streaming ReAct agent reasoning.

---

## ✨ Key Features

- **Hybrid Search Engine**: Combines vector similarity (cosine distance via `pgvector`) with full-text keyword search using Reciprocal Rank Fusion (RRF).
- **Cross-Encoder Reranking**: Re-orders retrieved context chunks for maximum relevance before passing them to the LLM.
- **ReAct AI Agent**: Real-time agentic reasoning powered by Google Gemini with WebSocket streaming support (`Agent WS`).
- **Document Upload**: `POST /api/v1/documents/upload` accepts PDF (text-based only — scanned/image-only PDFs are rejected), TXT, MD, CSV (10 MB file, 500k characters, 200 PDF pages) and ingests in the background.
- **High-Performance Caching**: Redis-backed caching — embeddings cached for 24 hours, search results for 5 minutes — to minimize API cost and latency.
- **Observability & Metrics**: OpenTelemetry tracing when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (off by default in production), Prometheus metrics guarded by `METRICS_TOKEN`, and a local Prometheus/Grafana/Jaeger stack via `npm run monitoring:up`.
- **Robust Error Handling**: Structured Express middleware with automated 429 rate limit detection and fallback generation modes.
- **Comprehensive Test Suite**: 602 unit tests across 40 suites plus 7 integration tests; statement coverage 76% (CI floor: 61/52/59/61).
- **Voice Data Retention**: Voice transcripts are text-only (raw audio is never stored) and count as personal data — kept **30 days**, purged by three sweeps (on service startup, after each save, and by a daily in-process timer that is unref'd and cleared on graceful shutdown), and fully removed when a user is deleted (foreign-key cascade).

---

## 🛠️ Technology Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend** | React, TypeScript, Vite, TailwindCSS / Custom CSS, Axios, WebSockets |
| **Backend** | Node.js 22, Express, TypeScript, Prisma ORM, OpenTelemetry |
| **Database** | PostgreSQL 16 + `pgvector` (Vector Search, `vector(768)` + HNSW) |
| **Caching & Queues** | Redis, [Bull](https://github.com/OptimalBits/bull) job queue (not BullMQ) |
| **LLM & Embeddings** | Google Gemini — `gemini-embedding-001` at **768 dims**; generation model from `GEMINI_GENERATION_MODEL` (default `gemini-3.6-flash`) |
| **Testing** | Jest, Supertest |

**Local dev ports:** backend `3001`, frontend (Vite) `5173`, Postgres `5433` → container `5432`, Redis `6379`.

---

## 🚀 Quick Start Guide

### Prerequisites

- **Node.js**: v22.0.0 or higher (see `.nvmrc`)
- **Docker & Docker Compose**: For running PostgreSQL (`pgvector`) and Redis
- **Gemini API Key**: Free or Paid key from [Google AI Studio](https://aistudio.google.com/)

---

### Step 1: Clone & Configure Environment

1. Navigate to the backend directory and copy the environment template:
   ```bash
   cd backend
   cp .env.example .env
   ```

2. Open `.env` and fill in your **Gemini API Key**:
   ```env
   DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ragdb"
   REDIS_URL="redis://localhost:6379"
   GEMINI_API_KEY="your_gemini_api_key_here"
   JWT_SECRET="your_32_character_jwt_secret_here"
   JWT_REFRESH_SECRET="your_32_character_jwt_refresh_secret"
   PORT=3001
   ```

---

### Step 2: Start Infrastructure (Database & Redis)

Start PostgreSQL (`pgvector`) and Redis using Docker Compose from the root folder:

```bash
docker compose up -d
```

Postgres is published on host port **5433** (to avoid clashing with any local Postgres) and Redis on **6379**.

---

### Step 3: Initialize Database Schema

Run Prisma migrations to create the database tables and pgvector indexes:

```bash
cd backend
npx prisma migrate dev
```

---

### Step 4: Start Backend & Frontend Services

#### Option A: Running Backend
```bash
cd backend
npm install
npm run dev
```
*Backend server runs at:* `http://localhost:3001`  
*Swagger API Docs available at:* `http://localhost:3001/api/docs`

#### Option B: Running Frontend
In a separate terminal window:
```bash
cd frontend
npm install
npm run dev
```
*Frontend app runs at:* `http://localhost:5173`

---

## 🧪 Testing Instructions

### Running Offline Unit Tests (0 API Tokens Used)
The test suite uses mock collaborators and mock API responses to run 100% offline without consuming Gemini API tokens:

```bash
cd backend
npm test
```

### Free Tier Gemini API Testing Best Practices
When testing with a free Gemini API key:
- **Use Micro Documents**: Test document upload using short 1-page sample files (100–300 words). This generates 1 chunk (~50 tokens) instead of 40+ chunks (~10,000+ tokens).
- **Leverage Redis Cache**: Once a text chunk is embedded, subsequent queries hit Redis cache with **0 API token usage**.
- For detailed token management strategies, see [docs/gemini-testing-guide.md](docs/gemini-testing-guide.md).

---

## 🔍 Code Quality & CI Checks

Run these before pushing — they mirror the CI pipeline:

```bash
cd backend

npm run lint                            # ESLint — zero warnings allowed (includes the no-any rules)
npx prettier --check "src/**/*.ts"      # Prettier — check formatting (CI fails on this)
npx prettier --write "src/**/*.ts"      # Prettier — auto-fix formatting
npm run type-check                      # TypeScript strict check (tsc --noEmit)
npm run test:coverage                   # Tests + coverage (CI floor: 61/52/59/61)
npm run build                           # Compile TypeScript to dist/
```

Frontend checks:

```bash
cd frontend

npm run lint                            # ESLint
npm run build                           # Type-check + production build (tsc -b && vite build)
npm run preview                         # Serve the production build locally
```

### Other backend commands

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Dev server with hot reload (`ts-node-dev`) |
| `npm start` | Run the compiled build (`dist/app.js`) |
| `npm run monitoring:up` / `monitoring:down` / `monitoring:logs` | Prometheus + Grafana + Jaeger stack |
| `npm run loadtest:all` | Run all Artillery load-test scenarios (see [backend/load-tests/README.md](backend/load-tests/README.md)) |

---

## 📖 API Documentation

Once the backend is running, explore the interactive Swagger documentation at:
**`http://localhost:3001/api/docs`**

### Core Endpoints:
- `POST /api/v1/auth/register` & `POST /api/v1/auth/login` — Authentication
- `POST /api/v1/documents/upload` — Multipart file upload (PDF — text-based only, TXT, MD, CSV; 10 MB max) — returns 202 with a job id
- `POST /api/v1/documents/ingest` — Ingest a document as text (JSON body: `name`, `content`, `mimeType`; 500k char limit) — returns a job id
- `GET /api/v1/documents/jobs/{jobId}` — Poll ingestion job status (404 for other users' jobs)
- `POST /api/v1/rag/query` — RAG hybrid search & grounded generation
- `POST /api/v1/rag/query-with-rerank` — RAG + Cross-encoder reranking
- `POST /api/v1/agent/chat` — ReAct Agent reasoning step-by-step
