// backend/src/types/retrieval.types.ts
// All types for the retrieval pipeline.
// These flow through: VectorSearchService → KeywordSearchService →
//                     HybridSearchService → RerankerService → GenerationService
//
// Defining them all now means every future service has a stable type contract.
// When GenerationService (Day 11) needs Citation[], the type is already here.

// ── Search Result Types ────────────────────────────────────────────────────

// The shape of a chunk row as returned from pgvector search queries.
// Note: we do NOT include the embedding column — it's 768 numbers we do not
// need to send back over the wire after we've already used it for comparison.
export interface ChunkSearchResult {
  id: string
  documentId: string
  content: string
  chunkIndex: number
  tokenCount: number
  source: string // document filename — shown in citations
  pageNumber: number | null
  chunkingStrategy: string
  createdAt: Date
}

// Result of a vector similarity search.
// cosineSimilarity is computed from pgvector's <=> distance operator:
//   similarity = 1 - cosineDistance
export interface VectorSearchResult {
  chunk: ChunkSearchResult
  cosineSimilarity: number // 0-1, higher = more semantically similar
  rank: number // position in the result list (0-based)
}

// Result of a keyword (BM25/tsvector) search.
// Used in Day 10's HybridSearchService.
export interface KeywordSearchResult {
  chunk: ChunkSearchResult
  bm25Score: number // term frequency score — higher = more keyword matches
  rank: number
}

// Result after combining vector + keyword with Reciprocal Rank Fusion.
// Used in Day 10's HybridSearchService.
export interface HybridSearchResult {
  chunk: ChunkSearchResult
  vectorRank: number // rank from vector search (999 if not in vector results)
  keywordRank: number // rank from keyword search (999 if not in keyword results)
  rrfScore: number // Reciprocal Rank Fusion score — used for final ordering
  rerankScore?: number // cross-encoder score added by RerankerService (Day 17)
}

// ── Search Options ────────────────────────────────────────────────────────

export interface VectorSearchOptions {
  topK: number // how many results to return (default: 10)
  minSimilarity: number // minimum cosine similarity threshold (default: 0.0)
  documentIds?: string[] // optional: restrict search to specific documents
  userId?: string // optional: restrict to documents owned by this user
}

export interface KeywordSearchOptions {
  topK: number
  documentIds?: string[]
  userId?: string
}

export interface HybridSearchOptions {
  topK: number
  minSimilarity: number
  useReranker: boolean // run cross-encoder second pass (Day 17)
  documentIds?: string[]
  userId?: string
}

// ── Citation Types ────────────────────────────────────────────────────────
// What the frontend shows next to each answer — "This answer is from page 3
// of Q3-Report.pdf, score 0.87"

export interface Citation {
  chunkId: string
  documentId: string
  documentName: string
  pageNumber?: number
  excerpt: string // first 200 chars of the chunk — shown in UI
  relevanceScore: number // the score used to rank this chunk (0-1)
}

// ── Agent Types (defined now, used from Day 14) ────────────────────────────

export type AgentStatus =
  | "idle"
  | "thinking"
  | "searching"
  | "generating"
  | "evaluating"
  | "done"
  | "error"

export type TaskType = "rag_search" | "web_search" | "math" | "general"
