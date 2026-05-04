```markdown
# Research Assistant Platform – RAG System

A production‑grade **Retrieval‑Augmented Generation (RAG)** platform that ingests documents, converts them into vector embeddings, and enables semantic search over your private knowledge base.

Built with **TypeScript**, **Express**, **PostgreSQL + pgvector**, **Redis**, and the **Gemini API**.

---

## 🧠 What This Project Does

- **Ingests** plain text documents (PDF support coming in Day 19)
- **Chunks** text using recursive, sentence‑aware, or fixed‑size strategies
- **Embeds** chunks into 3072‑dimensional vectors via `gemini-embedding-001`
- **Caches** embeddings in Redis to avoid duplicate API calls
- **Stores** vectors in PostgreSQL with pgvector for similarity search
- **Prepares** for semantic search (Day 9) and LLM generation (Day 11)

---

## 🛠️ Tech Stack

| Layer           | Technology                                                                 |
|-----------------|----------------------------------------------------------------------------|
| Runtime         | Node.js 20+                                                                |
| Language        | TypeScript (strict mode, zero `any`)                                       |
| Framework       | Express 5                                                                  |
| Database        | PostgreSQL 16 + pgvector (vector(3072))                                    |
| ORM             | Prisma (with raw SQL for pgvector)                                         |
| Cache / Queue   | Redis 7 (embedding cache, future Bull queues)                              |
| Embeddings      | Google Gemini `gemini-embedding-001` (3072 dimensions)                     |
| Auth            | JWT (access + refresh tokens), bcrypt                                      |
| Logging         | Winston (structured JSON logs + daily rotate)                              |
| Metrics         | Prometheus client (`/metrics` endpoint)                                    |
| API Docs        | Swagger UI (`/api/docs`)                                                   |
| Testing         | Jest (85+ unit tests, mocked external APIs)                                |
| Containerisation| Docker Compose                                                             |

---

## 📦 Prerequisites

- **Node.js** 20+ and npm
- **Docker Desktop** (for PostgreSQL + Redis)
- **Gemini API key** – get one free at [Google AI Studio](https://aistudio.google.com)

---

## 🚀 Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/darunbjork/research-assistant-platform.git
cd research-assistant-platform
```

### 2. Set up environment variables

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and add your Gemini API key:

```env
GEMINI_API_KEY=your_gemini_api_key_here
DATABASE_URL="postgresql://user:password@localhost:5432/ragdb"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="a_secure_32_char_secret"
JWT_REFRESH_SECRET="another_32_char_secret"
```

### 3. Start infrastructure (PostgreSQL + Redis)

```bash
docker compose up -d
```

### 4. Install dependencies & run database migrations

```bash
cd backend
npm install
npx prisma migrate deploy
```

### 5. Start the development server

```bash
npm run dev
```

You should see:

```
✅ Server running  → http://localhost:3001
🏥 Health check   → http://localhost:3001/health
📊 Metrics        → http://localhost:3001/metrics
📖 API Docs       → http://localhost:3001/api/docs
```

---

## 🧪 Testing the Pipeline (Postman or curl)

### Register a new user

```bash
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"securepass123"}'
```

### Login and copy the `accessToken`

```bash
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"securepass123"}'
```

### Ingest a document

```bash
curl -X POST http://localhost:3001/api/v1/documents/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "name": "ml-intro.txt",
    "content": "Machine learning is a subset of artificial intelligence.",
    "mimeType": "text/plain"
  }'
```

### List all documents

```bash
curl -X GET http://localhost:3001/api/v1/documents \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Get a document and its chunks

```bash
curl -X GET http://localhost:3001/api/v1/documents/DOCUMENT_ID \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Delete a document

```bash
curl -X DELETE http://localhost:3001/api/v1/documents/DOCUMENT_ID \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## 📁 Project Structure

```
backend/
├── prisma/
│   ├── schema.prisma          # Database schema (User, Document, DocumentChunk)
│   └── migrations/            # Prisma migration files
├── src/
│   ├── services/              # Business logic (chunking, embedding, ingestion)
│   ├── repositories/          # Database access (document, chunk)
│   ├── controllers/           # HTTP request handlers
│   ├── routes/                # Express route definitions
│   ├── middleware/            # Auth, error handling, logging
│   ├── types/                 # TypeScript interfaces (zero `any`)
│   ├── utils/                 # Redis client, logger, metrics, Swagger
│   └── __tests__/             # Unit tests (Jest)
├── .env.example               # Environment variables template
├── docker-compose.yml         # PostgreSQL + Redis containers
└── package.json
```

---

## 🔐 Authentication

- **JWT access token** (15 min expiry) – send in `Authorization: Bearer <token>`
- **Refresh token** (7 days expiry) – use `POST /api/v1/auth/refresh` to obtain new tokens
- Passwords hashed with **bcrypt** (cost factor 12)

---

## 📊 Monitoring & Observability

- **Health check** – `/health` returns status of API, database, and Redis
- **Prometheus metrics** – `/metrics` exposes request counts, latencies, cache hit rates
- **Structured logging** – Winston writes JSON logs to `logs/` directory and rotates daily
- **RAG‑specific events** – `chunk`, `embed`, `ingest` events track pipeline performance

---

## 🧪 Running Tests

```bash
npm test                 # Run all tests (85+)
npm run test:coverage    # Generate coverage report
npm run type-check       # TypeScript strict check
npm run no-any           # Verify zero `any` types
npm run lint             # ESLint
```

---

## 🐳 Docker Commands

```bash
# Start all services
docker compose up -d

# Stop services (preserve data)
docker compose down

# Stop and delete all data (fresh start)
docker compose down -v

# View logs
docker compose logs -f
```

---

## 🚧 What’s Next? (Days 9–25)

| Day | Feature |
|-----|---------|
| 9   | VectorSearchService – cosine similarity with pgvector (`<=>`) |
| 10  | Reranking & hybrid search (BM25 + vector) |
| 11  | GenerationService – call Gemini for answers |
| 12  | Agent orchestration (LangGraph or custom) |
| 13  | Web search integration (Tavily API) |
| 14  | Multi‑turn conversations with memory |
| 15  | PDF parsing (text extraction) |
| 16  | File uploads (Multer) |
| 17  | Async ingestion with Bull queues |
| 18  | Rate limiting & API keys for external users |
| 19  | Production deployment (Fly.io / Render) |
| 20  | Monitoring (Sentry, Uptime) |
| 21  | E2E tests with Playwright |
| 22  | Prompt versioning & A/B testing |
| 23  | Observability dashboards (Grafana) |
| 24  | Fine‑tuning embeddings |
| 25  | Launch & documentation |

---

## 🤝 Contributing

This is a learning bootcamp project. Issues and pull requests are welcome for improvements or bug fixes.

---

## 📄 License

ISC

---

**Made with ❤️ as part of the 25‑Day RAG Bootcamp**  
[GitHub Repository](https://github.com/darunbjork/research-assistant-platform)
```