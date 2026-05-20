# Research Assistant Platform — Architecture Document

**Version**: 1.0  
**Date**: May 2026  
**Author**: [Your Name]  
**Repository**: https://github.com/darunbjork/research-assistant-platform

---

## 1. System Overview

The Research Assistant Platform is a production-grade
Retrieval-Augmented Generation (RAG) system that enables users to
upload documents and receive grounded, cited answers from an autonomous
AI agent. The system combines hybrid search (vector + keyword),
cross-encoder reranking, self-correcting agent loops, and real-time
WebSocket streaming to deliver answers that are both accurate and
transparent.

**Scale targets:**
- 50 concurrent users
- Sub-3-second P95 latency for RAG queries (cached)
- 640+ unit tests, 82% line coverage
- Zero-downtime deployments via GitHub Actions CI/CD

---

## 2. Architecture Diagram

```mermaid
graph TB
  subgraph Client["Client Layer"]
    UI[React + Vite Frontend]
    WS_CLIENT[WebSocket Client<br/>useAgentWebSocket hook]
  end

  subgraph Gateway["API Gateway — Express + Node.js 20"]
    AUTH[JWT Auth Middleware]
    RATE[Redis Rate Limiter<br/>per-user per-endpoint]
    AC[Access Control<br/>Document Ownership]
    HTTP_ROUTES[HTTP Routes<br/>RAG / Agent / Eval / Docs]
    WS_SERVER[WebSocket Server<br/>ws://localhost:3001/ws/agent]
  end

  subgraph RAGPipeline["RAG Pipeline"]
    EMBED[EmbeddingService<br/>Gemini text-embedding-004<br/>Redis cache TTL=24h]
    HYBRID[HybridSearchService<br/>Vector + Keyword + RRF<br/>Redis cache TTL=5min]
    RERANK[RerankerService<br/>Cross-encoder via Gemini<br/>Pointwise scoring 0-10]
    GEN[GenerationService<br/>Gemini 2.0 Flash<br/>Anti-hallucination prompt]
    RAG_SVC[RagService<br/>Orchestrator]
  end

  subgraph AgentLoop["ReAct Agent Loop"]
    AGENT[AgentService<br/>MAX_ITERATIONS=5]
    CLASSIFY[ClassifyNode<br/>rag/math/web/general]
    TOOLS[Tool Registry<br/>rag_search + calculator]
    EVAL_NODE[EvaluatorNode<br/>RAG Triad scoring<br/>Quality threshold=0.7]
    STREAMING[StreamingAgentService<br/>Event callback pattern]
  end

  subgraph Storage["Storage Layer"]
    PG[(PostgreSQL 16<br/>pgvector IVFFlat<br/>768-dim vectors)]
    REDIS[(Redis 7<br/>Embedding cache<br/>Search cache<br/>Bull Queue<br/>Rate limit counters)]
  end

  subgraph Queue["Async Processing"]
    BULL[Bull Queue<br/>CONCURRENCY=3<br/>MAX_ATTEMPTS=3]
    WORKER[Ingestion Worker<br/>Chunk → Embed → Store]
  end

  subgraph Observability["Observability"]
    PROM[Prometheus<br/>/metrics endpoint]
    GRAFANA[Grafana<br/>12-panel dashboard]
    OTEL[OpenTelemetry<br/>Jaeger traces]
  end

  subgraph CI["CI/CD — GitHub Actions"]
    PIPELINE[9-step pipeline<br/>type-check → no-any →<br/>lint → test → coverage → build]
  end

  UI -- HTTP --> HTTP_ROUTES
  WS_CLIENT -- WebSocket --> WS_SERVER
  HTTP_ROUTES --> AUTH --> RATE --> AC
  AC --> RAG_SVC
  AC --> AGENT
  WS_SERVER --> STREAMING --> AGENT

  RAG_SVC --> EMBED --> REDIS
  RAG_SVC --> HYBRID --> PG
  HYBRID --> RERANK
  HYBRID --> REDIS
  RAG_SVC --> GEN

  AGENT --> CLASSIFY
  AGENT --> TOOLS --> RAG_SVC
  AGENT --> EVAL_NODE

  EMBED --> PG
  HYBRID --> PG

  HTTP_ROUTES --> BULL --> REDIS
  BULL --> WORKER --> PG

  PROM --> GRAFANA
  OTEL --> GRAFANA
```

---

## 3. Request Lifecycle — End to End

### 3a. RAG Query (POST /api/v1/rag/query)