// ! All types related to documents, chunks, and the chunking process.

// TODO: The strategies for splitting a document into chunks.
// "fixed"     = every N characters, with overlap
// "sentence"  = split on sentence boundaries, group up to token limit
// "recursive" = split on paragraphs → sentences → words
// "semantic"  = group sentences by meaning similarity (advanced)
export type ChunkingStrategy = "fixed" | "sentence" | "recursive" | "semantic"

// The raw output of the chunking step — before embedding
export interface RawChunk {
  content: string
  chunkIndex: number
  tokenCount: number
}

// A chunk after embedding — ready to store in pgvector
export interface DocumentChunk {
  id: string
  documentId: string
  content: string
  chunkIndex: number
  tokenCount: number
  embedding: number[]       // * the 768-number vector
  metadata: ChunkMetadata
  createdAt: Date
}

export interface ChunkMetadata {
  source: string             // document name — used in citations
  pageNumber?: number        // page number if extracted from PDF
  section?: string           // section heading if available
  chunkingStrategy: ChunkingStrategy
}

// What we receive from a document upload request
export interface DocumentUploadRequest {
  name: string
  content: string
  mimeType: string
  sizeBytes: number
}