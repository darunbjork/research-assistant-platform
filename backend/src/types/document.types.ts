// TODO: The strategies for splitting a document into chunks.
// ! All types related to documents, chunks, and the RAG ingestion pipeline.
// These types flow through: upload → chunk → embed → store → retrieve → cite

// ── Chunking Types ────────────────────────────────────────────────────────

// The four strategies for splitting a document into chunks.
// "fixed"     = every N characters with overlap (simplest, most predictable)
// "sentence"  = group full sentences up to a token limit (better for Q&A)
// "recursive" = split on paragraphs → sentences → words (respects structure)
// "semantic"  = group sentences by meaning similarity (most advanced, Day 8+)
export type ChunkingStrategy = "fixed" | "sentence" | "recursive" | "semantic"

export interface FixedChunkConfig {
  chunkSize: number // target character count per chunk (default: 512)
  overlap: number // characters shared between adjacent chunks (default: 50)
}

// Configuration for the sentence-aware chunking strategy
export interface SentenceChunkConfig {
  maxTokens: number // maximum tokens per chunk (default: 200)
  minTokens: number // minimum tokens before splitting (default: 50)
}

// Configuration for the recursive chunking strategy
export interface RecursiveChunkConfig {
  maxChunkSize: number // max characters per chunk (default: 512)
  overlap: number // overlap between chunks (default: 50)
  // Separators tried in order — splits on the first one that works
  // Tries paragraph breaks first, then sentences, then words, then characters
  separators: string[]
}

// Union of all config types — a function can accept any of these
export type ChunkConfig = FixedChunkConfig | SentenceChunkConfig | RecursiveChunkConfig

// ── Raw Chunk (before embedding) ─────────────────────────────────────────
// What ChunkingService produces BEFORE sending to EmbeddingService.
// The embedding field is absent — it gets added in Day 7.
export interface RawChunk {
  content: string // the actual text of this chunk
  chunkIndex: number // position in the document (0-based)
  tokenCount: number // estimated token count (4 chars ≈ 1 token)
  characterCount: number // exact character count
  strategy: ChunkingStrategy // which strategy produced this chunk
}

// ── Document Chunk (after embedding, stored in pgvector) ─────────────────
// RawChunk + embedding vector + metadata + database ID
export interface DocumentChunk {
  id: string
  documentId: string
  content: string
  chunkIndex: number
  tokenCount: number
  embedding: number[] // 768-dimensional vector from Gemini
  metadata: ChunkMetadata
  createdAt: Date
}

export interface ChunkMetadata {
  source: string // document name — shown in citations
  pageNumber?: number // if extracted from a PDF
  section?: string // heading/section if available
  chunkingStrategy: ChunkingStrategy
  characterCount: number
}

// ── Retrieval Types (used from Day 9) ─────────────────────────────────────
export type RetrievalStrategy = "vector" | "keyword" | "hybrid"

export interface RetrievalOptions {
  strategy: RetrievalStrategy
  topK: number // how many chunks to return (default: 10)
  minSimilarity: number // minimum cosine similarity threshold (0-1)
  useReranker: boolean // run cross-encoder second pass (Day 17)
}

// ── Document Upload ────────────────────────────────────────────────────────
// What the upload endpoint receives from the client
export interface DocumentUploadRequest {
  name: string // original filename
  content: string // extracted text content
  mimeType: string // "application/pdf", "text/plain", etc.
  sizeBytes: number // file size in bytes
}

// What the upload endpoint returns to the client
export interface DocumentUploadResponse {
  documentId: string
  name: string
  chunkCount: number // how many chunks were created
  tokenCount: number // total estimated tokens across all chunks
  status: "ingesting" | "ready" | "failed"
}
