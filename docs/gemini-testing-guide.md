# Testing `research-assistant-platform` with Gemini Free Tier API

## Overview
When using the Google Gemini **Free API Key**, large PDF uploads or heavy RAG workflows can quickly consume free rate limits (Tokens Per Minute - TPM and Requests Per Day - RPD). 

This guide explains **why** tokens get consumed quickly in `research-assistant-platform` and **how to test your app** without exhausting your daily API quota.

---

## 1. Why Gemini Free Tokens Get Consumed Quickly

In `research-assistant-platform`, a single PDF ingestion or chat query triggers multiple Gemini API calls across the pipeline:

| Pipeline Step | Service Involved | Gemini API Model | Why It Consumes Tokens |
| :--- | :--- | :--- | :--- |
| **Document Ingestion** | `EmbeddingService` | `gemini-embedding-001` / `text-embedding-004` | PDF text is split into chunks. **Every chunk** generates a batch embedding call. A 20-page document produces ~40+ chunks. |
| **Answer Generation** | `GenerationService` / `AgentService` | `gemini-2.0-flash` | The prompt + retrieved document chunks + LLM output response consume input & output tokens. |
| **RAG Evaluation** | `EvaluatorService` | `gemini-2.0-flash` | Fires **3 extra Gemini API calls** per response to evaluate Faithfulness, Context Relevance, and Answer Relevance. |

---

## 2. Recommended Testing Strategies

### Strategy 1: Run Automated Offline Unit Tests (0 Tokens Used)
The backend features isolated unit test suites using mocked Gemini collaborators (`makeMockEmbeddingService()`, fake fetch responses).

To test application logic without consuming any API tokens, run:
```bash
cd backend
npm test
```
* **Token Cost**: **0 Tokens**
* **Best For**: Verifying code logic, chunking algorithms, error handlers, and repository operations.

---

### Strategy 2: Test with Micro-PDFs or Short Sample Documents
When performing live manual testing via the API (`POST /api/v1/documents`) or Swagger UI:
* **Avoid**: Uploading 10–50 page PDFs during development.
* **Do**: Use a 1-page PDF or short plain text sample (100–300 words).

**Token Impact Comparison:**
* **Full PDF (20 pages)**: ~40 chunks → **~40 embedding calls (~10,000+ tokens)**.
* **Micro Document (1 page)**: 1 chunk → **1 embedding call (~50 tokens)**.

---

### Strategy 3: Enable and Utilize Redis Embedding Cache
The `EmbeddingService` includes built-in Redis caching (`CACHE_TTL_SECONDS = 86400` / 24 hours):

1. Start Redis in your docker environment:
   ```bash
   docker-compose up -d redis
   ```
2. When you re-ingest or search against identical text chunks, `EmbeddingService` retrieves vector embeddings from Redis instead of calling Gemini.
* **Token Cost on Cache Hit**: **0 Tokens**.

---

### Strategy 4: Temporarily Skip RAG Triad Evaluation
During basic feature or UI testing, disable or skip the RAG evaluation step.
* Evaluating each response executes 3 evaluation prompts against Gemini (`gemini-2.0-flash`).
* Bypassing evaluation during testing saves **3 API calls per prompt**.

---

### Strategy 5: Adjust Chunk Size in Ingestion Configuration
Increase the default chunk size during development to generate fewer total chunks per document:

In `backend/src/services/ingestion.service.ts`:
```typescript
const DEFAULT_CONFIG: IngestionConfig = {
  chunkingStrategy: "recursive",
  chunkSize: 1000, // Increased from 512 to 1000 characters
  overlap: 50,
  maxDocumentSize: 500_000,
}
```
* **Effect**: Halves the total number of chunks created and cuts total embedding API calls by 50%.

---

## Quick Summary Matrix

| Method | Token Reduction | Best Used For |
| :--- | :--- | :--- |
| **`npm test` (Mocked Unit Tests)** | **100% (0 Tokens)** | Developer code verification & CI/CD |
| **Redis Embedding Cache** | **100% on repeat text** | Manual testing & repeated queries |
| **Micro Documents (1-2 pages)** | **~90-95% reduction** | Manual API / Swagger ingestion tests |
| **Skip RAG Evaluation** | **Saves 3 calls / request** | Chat / Agent testing |
| **Larger `chunkSize` (1000+)** | **~50% reduction** | Full document integration testing |
