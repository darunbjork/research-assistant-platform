// frontend/src/types/index.ts
// Shared types between frontend and backend.
// These mirror the backend types — one source of truth for both sides.
// In a monorepo, you would share these from a packages/types folder.
// For now, we duplicate them here and keep them in sync manually.

// ── API Response Envelope ─────────────────────────────────────────────────
// Every backend response follows this shape.
export interface ApiResult<TData> {
  success: boolean
  data:    TData | null
  error:   string | null
  meta?: {
    page?:  number
    limit?: number
    total?: number
  }
}

// ── Auth Types ────────────────────────────────────────────────────────────
export interface AuthTokens {
  accessToken:  string
  refreshToken: string
}

export interface PublicUser {
  id:        string
  email:     string
  role:      "GUEST" | "USER" | "ADMIN"
  createdAt: string
}

export interface AuthResponse {
  tokens: AuthTokens
  user:   PublicUser
}

// ── Document Types ────────────────────────────────────────────────────────
export interface DocumentSummary {
  id:         string
  name:       string
  mimeType:   string
  sizeBytes:  number
  userId:     string
  createdAt:  string
  updatedAt:  string
  chunkCount: number
}

export interface IngestionResult {
  documentId:  string
  name:        string
  chunkCount:  number
  tokenCount:  number
  strategy:    string
  durationMs:  number
  warnings:    string[]
}

// ── RAG / Citation Types ──────────────────────────────────────────────────
export interface Citation {
  chunkId:        string
  documentId:     string
  documentName:   string
  pageNumber?:    number
  excerpt:        string
  relevanceScore: number
}

export interface RagResult {
  answer:          string
  citations:       Citation[]
  chunksRetrieved: number
  chunksUsed:      number
  tokensUsed:      number
  model:           string
  durationMs:      number
  retrievalMs:     number
  generationMs:    number
}

// ── Chat Types ────────────────────────────────────────────────────────────
export type AgentStatus =
  | "idle"
  | "thinking"
  | "searching"
  | "generating"
  | "done"
  | "error"

export type MessageSender = "user" | "agent"

export interface ChatMessage {
  id:         string
  text:       string
  sender:     MessageSender
  timestamp:  string
  citations?: Citation[]
  status?:    AgentStatus
  metadata?: {
    chunksRetrieved: number
    tokensUsed:      number
    durationMs:      number
  }
}
