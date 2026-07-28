# ResearchBot — Production-Grade Agentic RAG Platform

![ResearchBot Main Interface](docs/screenshots/app-interface-1.png)

![ResearchBot Text Upload & Engine](docs/screenshots/app-interface-2.png)

---

## 📌 Overview

**ResearchBot** is a full-stack, enterprise-grade Retrieval-Augmented Generation (RAG) and Agentic platform. Built with Node.js, Express, TypeScript, React, PostgreSQL (`pgvector`), Redis, and Google Gemini API, it provides intelligent document search, cross-encoder reranking, and real-time streaming ReAct agent reasoning.

---

## ✨ Key Features

- **Hybrid Search Engine**: Combines vector similarity (cosine distance via `pgvector`) with full-text keyword search using Reciprocal Rank Fusion (RRF).
- **Cross-Encoder Reranking**: Re-orders retrieved context chunks for maximum relevance before passing them to the LLM.
- **ReAct AI Agent**: Real-time agentic reasoning powered by `gemini-2.0-flash` with WebSocket streaming support (`Agent WS`).
- **High-Performance Caching**: Redis-backed 24-hour caching for vector embeddings and search queries to minimize API cost and latency.
- **Observability & Metrics**: Built-in OpenTelemetry tracing, Prometheus metrics, and Jaeger integration.
- **Robust Error Handling**: Structured Express middleware with automated 429 rate limit detection and fallback generation modes.
- **Comprehensive Test Suite**: 454 unit and integration tests passing across 25 test suites.

---

## 🛠️ Technology Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend** | React, TypeScript, Vite, TailwindCSS / Custom CSS, Axios, WebSockets |
| **Backend** | Node.js, Express, TypeScript, Prisma ORM, OpenTelemetry |
| **Database** | PostgreSQL + `pgvector` (Vector Search) |
| **Caching & Queues** | Redis, BullMQ |
| **LLM & Embeddings** | Google Gemini (`gemini-2.0-flash`, `gemini-embedding-001`) |
| **Testing** | Jest, Supertest |

---

## 🚀 Quick Start Guide

### Prerequisites

- **Node.js**: v18.0.0 or higher
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
   PORT=3002
   ```

---

### Step 2: Start Infrastructure (Database & Redis)

Start PostgreSQL (`pgvector`) and Redis using Docker Compose from the root folder:

```bash
docker-compose up -d
```

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
*Backend server runs at:* `http://localhost:3002`  
*Swagger API Docs available at:* `http://localhost:3002/api-docs`

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

## 📖 API Documentation

Once the backend is running, explore the interactive Swagger documentation at:
**`http://localhost:3002/api-docs`**

### Core Endpoints:
- `POST /api/v1/auth/register` & `POST /api/v1/auth/login` — Authentication
- `POST /api/v1/documents` — Ingest document text / .txt files
- `POST /api/v1/rag/query` — RAG hybrid search & grounded generation
- `POST /api/v1/rag/query-with-rerank` — RAG + Cross-encoder reranking
- `POST /api/v1/agent/chat` — ReAct Agent reasoning step-by-step
