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

// ── Reranker Types ────────────────────────────────────────────────────────

// A chunk after cross-encoder reranking.
// rerankScore replaces rrfScore as the primary ordering key.
export interface RerankedResult {
  chunk: ChunkSearchResult
  vectorRank: number // original rank from vector search
  keywordRank: number // original rank from keyword search
  rrfScore: number // original RRF score (preserved for comparison)
  rerankScore: number // 0-1, cross-encoder relevance score
  originalRank: number // position before reranking (0-based)
  rerankedRank: number // position after reranking (0-based)
}

// Configuration for the reranker
export interface RerankerOptions {
  topK: number // how many results to return after reranking
  minRerankScore: number // discard results below this score (default: 0.0)
  batchSize: number // how many chunks to score in one LLM call (default: 10)
}

// Comparison between pre- and post-reranking for debugging
export interface RerankComparison {
  query: string
  original: HybridSearchResult[]
  reranked: RerankedResult[]
  movedUp: number // chunks whose rank improved
  movedDown: number // chunks whose rank decreased
  unchanged: number // chunks whose rank stayed the same
  durationMs: number
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
