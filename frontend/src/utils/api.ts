// frontend/src/utils/api.ts
// Centralised API client for all backend requests.
// Uses axios with a base URL and automatic auth token injection.
//
// WHY AXIOS OVER FETCH:
// Axios automatically:
//   - Throws for non-2xx status codes (fetch does not)
//   - Parses JSON responses (fetch requires .json())
//   - Supports request interceptors (adding the Bearer token to every call)
//   - Provides better TypeScript generics for response shapes

import axios, { type AxiosError } from "axios"
import type {
  ApiResult,
  AuthResponse,
  IngestionResult,
  DocumentSummary,
  RagResult
} from "../types"

// ── Base URL ──────────────────────────────────────────────────────────────
// Vite exposes env variables prefixed with VITE_ via import.meta.env
// VITE_API_URL is set in frontend/.env
const BASE_URL = import.meta.env.VITE_API_URL as string ?? "http://localhost:3001"

// ── Axios Instance ────────────────────────────────────────────────────────
const api = axios.create({
  baseURL: `${BASE_URL}/api/v1`,
  headers: { "Content-Type": "application/json" }
})

// ── Request Interceptor: Inject Auth Token ────────────────────────────────
// Runs before EVERY request. Reads the access token from localStorage
// and adds it as the Authorization header.
// This means individual API functions do not need to handle auth.
api.interceptors.request.use(config => {
  const token = localStorage.getItem("accessToken")
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// ── Response Interceptor: Handle 401 ──────────────────────────────────────
// If the backend returns 401 (token expired), clear auth and redirect to login.
api.interceptors.response.use(
  response => response,
  async (error: AxiosError) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("accessToken")
      localStorage.removeItem("refreshToken")
      // Redirect to login — avoids circular dependency with React Router
      window.location.href = "/login"
    }
    return Promise.reject(error)
  }
)

// ── Auth API ──────────────────────────────────────────────────────────────

export async function register(
  email:    string,
  password: string
): Promise<AuthResponse> {
  const response = await api.post<ApiResult<AuthResponse>>(
    "/auth/register",
    { email, password }
  )

  if (!response.data.success || !response.data.data) {
    throw new Error(response.data.error ?? "Registration failed")
  }

  return response.data.data
}

export async function login(
  email:    string,
  password: string
): Promise<AuthResponse> {
  const response = await api.post<ApiResult<AuthResponse>>(
    "/auth/login",
    { email, password }
  )

  if (!response.data.success || !response.data.data) {
    throw new Error(response.data.error ?? "Login failed")
  }

  return response.data.data
}

// ── Document API ──────────────────────────────────────────────────────────

export async function ingestDocument(
  name:     string,
  content:  string,
  mimeType: string
): Promise<IngestionResult> {
  const response = await api.post<ApiResult<IngestionResult>>(
    "/documents/ingest",
    { name, content, mimeType }
  )

  if (!response.data.success || !response.data.data) {
    throw new Error(response.data.error ?? "Ingestion failed")
  }

  return response.data.data
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const response = await api.get<ApiResult<DocumentSummary[]>>("/documents")

  if (!response.data.success || !response.data.data) {
    throw new Error(response.data.error ?? "Failed to load documents")
  }

  return response.data.data
}

export async function deleteDocument(documentId: string): Promise<void> {
  await api.delete(`/documents/${documentId}`)
}

// ── RAG API ───────────────────────────────────────────────────────────────

export async function queryRag(
  query:         string,
  topK:          number  = 10,
  minSimilarity: number  = 0.0,
  documentIds?:  string[]
): Promise<RagResult> {
  const response = await api.post<ApiResult<RagResult>>("/rag/query", {
    query,
    topK,
    minSimilarity,
    documentIds
  })

  if (!response.data.success || !response.data.data) {
    throw new Error(response.data.error ?? "RAG query failed")
  }

  return response.data.data
}

export default api
