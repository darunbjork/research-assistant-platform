export interface ApiResult<T> {
  success: boolean
  data:    T | null
  error:   string | null
}
export interface AuthTokens {
  accessToken:  string
  refreshToken: string
}

export interface AuthUser {
  id:        string
  email:     string
  role:      "USER" | "ADMIN" | "GUEST"
  createdAt: string
}
export interface AuthResponse {
  tokens: AuthTokens
  user:   AuthUser
}
export interface DocumentSummary {
  id:         string
  name:       string
  mimeType:   string
  sizeBytes:  number
  userId:     string
  chunkCount: number
  createdAt:  string
  updatedAt:  string
}

export interface IngestionResult {
  documentId: string
  name:       string
  chunkCount: number
  tokenCount: number
  durationMs: number
}
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

export type AgentStatus =
  | "idle"
  | "thinking"
  | "searching"
  | "calculating"
  | "generating"
  | "evaluating"
  | "done"
  | "error"

export interface AgentStep {
  stepNumber:  number
  description: string
  toolUsed?:   string
  durationMs:  number
  timestamp:   string
}

export interface AgentResult {
  sessionId:      string
  finalAnswer:    string
  citations:      Citation[]
  steps:          AgentStep[]
  iterationCount: number
  status:         AgentStatus
  tokensUsed:     number
  durationMs:     number
}

export type MessageSender = "user" | "agent"

export interface ChatMessage {
  id:          string
  text:        string
  sender:      MessageSender
  timestamp:   string
  citations?:  Citation[]
  agentSteps?: AgentStep[]
  status?:     AgentStatus
  metadata?: {
    chunksRetrieved: number
    tokensUsed:      number
    durationMs:      number
    iterationCount?: number
  }
}