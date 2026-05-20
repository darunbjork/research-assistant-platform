# System Diagram — Research Assistant Platform

## High-Level Architecture

```mermaid
C4Context
  title Research Assistant Platform — System Context

  Person(user, "User", "Uploads documents and asks research questions")
  
  System(platform, "Research Assistant Platform", "RAG + AI Agent system for document Q&A")
  
  System_Ext(gemini, "Google Gemini API", "text-embedding-004 + Gemini 2.0 Flash")
  
  Rel(user, platform, "Uploads docs, asks questions", "HTTPS / WebSocket")
  Rel(platform, gemini, "Embeds text, generates answers, evaluates quality", "HTTPS REST")
```

## Container Diagram

```mermaid
C4Container
  title Research Assistant Platform — Containers

  Person(user, "User", "Browser or mobile")

  Container(frontend, "React Frontend", "React 18 + Vite + Tailwind",
    "Chat UI, document upload, agent steps, eval widget")
  
  Container(backend, "API Server", "Node.js 20 + Express + TypeScript",
    "HTTP REST API + WebSocket server. JWT auth, rate limiting, RAG pipeline")
  
  ContainerDb(postgres, "PostgreSQL 16 + pgvector",
    "Document storage, 768-dim vector search, full-text search (tsvector)")
  
  ContainerDb(redis, "Redis 7",
    "Embedding cache (24h TTL), search cache (5min TTL), Bull Queue, rate limit counters")
  
  Container(grafana, "Grafana", "Grafana 10",
    "12-panel monitoring dashboard. Latency, quality, cache, memory panels")
  
  Container(prometheus, "Prometheus", "Prometheus 2.48",
    "Time-series metrics storage. Scrapes /metrics every 15s")

  Rel(user, frontend, "Uses", "HTTPS")
  Rel(frontend, backend, "API calls", "HTTPS + WebSocket")
  Rel(backend, postgres, "Reads/writes", "Prisma ORM")
  Rel(backend, redis, "Cache + queue", "ioredis")
  Rel(backend, gemini, "Embed + generate", "fetch() HTTPS")
  Rel(prometheus, backend, "Scrapes metrics", "HTTP GET /metrics")
  Rel(grafana, prometheus, "Queries", "PromQL")
```

## RAG Pipeline — Sequence Diagram

```mermaid
sequenceDiagram
  actor User
  participant FE as React Frontend
  participant API as Express API
  participant Cache as Redis Cache
  participant Search as HybridSearch
  participant PG as pgvector
  participant Rerank as RerankerService
  participant Gen as GenerationService
  participant Gemini as Gemini API

  User->>FE: "What are the Q3 risks?"
  FE->>API: POST /api/v1/rag/query
  
  Note over API: Auth + Rate limit check
  
  API->>Cache: GET embedding cache key
  Cache-->>API: MISS
  
  API->>Gemini: embed("What are the Q3 risks?")
  Gemini-->>API: [0.12, -0.03, ...] 768-dim
  API->>Cache: SET embedding TTL=24h
  
  API->>Cache: GET search cache key
  Cache-->>API: MISS
  
  par Parallel search
    API->>PG: cosine similarity top-20
    PG-->>API: vector results
  and
    API->>PG: tsvector BM25 top-20
    PG-->>API: keyword results
  end
  
  API->>Search: RRF merge → top-10
  API->>Cache: SET search results TTL=5min
  
  API->>Rerank: pointwise score top-10→5
  Rerank->>Gemini: score each chunk
  Gemini-->>Rerank: scores [9, 7, 8, 4, 6, ...]
  Rerank-->>API: reranked top-5
  
  API->>Gen: generate(query, top-5 chunks)
  Gen->>Gemini: grounded generation
  Gemini-->>Gen: "The Q3 risks include... [Source 1]"
  
  API-->>FE: { answer, citations, durationMs }
  FE-->>User: Answer with expandable citations
```

## Agent ReAct Loop — Flow Diagram

```mermaid
flowchart TD
  Start([User query]) --> Classify{Classify query}
  
  Classify -->|math| MathPath[Include calculator tool]
  Classify -->|rag_search| RagPath[Document search focus]
  Classify -->|general| GenPath[General reasoning]
  
  MathPath & RagPath & GenPath --> Reason

  subgraph Loop["ReAct Loop (max 5 iterations)"]
    Reason["REASON\nGemini decides next tool\n(includes eval feedback)"] 
    Reason -->|DONE| ExitLoop([Exit loop])
    Reason -->|rag_search| RagTool["ACT: rag_search\nHybridSearch + Rerank"]
    Reason -->|calculator| CalcTool["ACT: calculator\nSafe math eval"]
    
    RagTool & CalcTool --> Observe["OBSERVE\nRecord tool output"]
    Observe --> Draft["DRAFT\nGenerate short answer\n(256 tokens, eval only)"]
    Draft --> Evaluate{"EVALUATE\nRAG Triad scoring"}
    
    Evaluate -->|"Score ≥ 0.7\n✅ sufficient"| ExitLoop
    Evaluate -->|"Score < 0.7\n🔄 retry"| Reason
  end
  
  ExitLoop --> Synthesise["SYNTHESISE\nFull answer (1024 tokens)\nwith citations"]
  Synthesise --> Stream["STREAM via WebSocket\nor HTTP response"]
  Stream --> End([User sees answer + steps])

  style Loop fill:#f8f9fa,stroke:#dee2e6
  style Evaluate fill:#fff3cd,stroke:#ffc107
```