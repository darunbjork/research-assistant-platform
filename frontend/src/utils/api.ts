// frontend/src/utils/api.ts

import axios from "axios"
import type { AxiosError, InternalAxiosRequestConfig } from "axios"
import type {
  ApiResult,
  AuthResponse,
  IngestionResult,
  DocumentSummary,
  RagResult,
  AgentResult
} from "../types"

interface RetryableRequest extends InternalAxiosRequestConfig {
  _retry?: boolean
}

const BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3002"

// ── Axios Instance ─────────────────────────────────────────────────────────
const api = axios.create({
  baseURL: `${BASE_URL}/api/v1`,
  headers: { "Content-Type": "application/json" }
})

// ── Request Interceptor: Inject Auth Token ─────────────────────────────────
api.interceptors.request.use(config => {
  const token = localStorage.getItem("accessToken")
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// ── Response Interceptor: Handle 401 + Token Refresh ─────────────────────
api.interceptors.response.use(
  response => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetryableRequest | undefined

    if (
      error.response?.status === 401 &&
      originalRequest !== undefined &&
      !originalRequest._retry
    ) {
      originalRequest._retry = true

      const refreshToken = localStorage.getItem("refreshToken")

      if (refreshToken) {
        try {
          const response = await api.post<ApiResult<AuthResponse>>(
            "/auth/refresh",
            { refreshToken }
          )

          if (response.data.success && response.data.data) {
            // AuthResponse has a nested `tokens` object
            const { accessToken, refreshToken: newRefreshToken } =
              response.data.data.tokens

            localStorage.setItem("accessToken",  accessToken)
            localStorage.setItem("refreshToken", newRefreshToken)

            originalRequest.headers.Authorization = `Bearer ${accessToken}`
            return api(originalRequest)
          }
        } catch {
          // Refresh failed — fall through to logout below
          // (catch block intentionally empty — no variable needed)
        }
      }

      // No refresh token or refresh failed — clear auth and redirect
      localStorage.removeItem("accessToken")
      localStorage.removeItem("refreshToken")
      window.location.href = "/login"
    }

    return Promise.reject(error)
  }
)

// ── Auth API ───────────────────────────────────────────────────────────────

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

// ── Document API ───────────────────────────────────────────────────────────

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

// ── RAG API ────────────────────────────────────────────────────────────────

export async function queryRag(
  query:         string,
  topK:          number   = 10,
  minSimilarity: number   = 0.0,
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

// ── Agent API ──────────────────────────────────────────────────────────────

export async function queryAgent(query: string): Promise<AgentResult> {
  const response = await api.post<ApiResult<AgentResult>>(
    "/agent/chat",
    { query }
  )

  if (!response.data.success || !response.data.data) {
    throw new Error(response.data.error ?? "Agent query failed")
  }

  return response.data.data
}

export default api