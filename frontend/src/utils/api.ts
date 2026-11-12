// frontend/src/utils/api.ts

import axios from "axios"
import type { AxiosError, InternalAxiosRequestConfig } from "axios"
import { clearTokens, getRefreshToken } from "./auth"
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

// Same origin by default: the Vite dev proxy forwards /api to the backend in
// dev, Caddy serves it in production. Set VITE_API_URL only for unusual
// split-origin setups.
const BASE_URL = import.meta.env.VITE_API_URL ?? ""

// ── Axios Instance ─────────────────────────────────────────────────────────
// No default Content-Type here: axios sets application/json for plain-object
// bodies and multipart/form-data (with boundary) for FormData — an instance
// default of application/json would break multipart uploads (task 4.2).
const api = axios.create({
  baseURL: `${BASE_URL}/api/v1`
})

// ── Request Interceptor: Inject Auth Token ─────────────────────────────────
api.interceptors.request.use(config => {
  const token = localStorage.getItem("accessToken")
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// ── Response interceptor: handle 401 + token refresh, surface API errors ──
// Backend errors arrive as { success: false, error: "..." } — unwrap the
// message so UI catch blocks showing `err.message` display the real reason
// (e.g. "An account with this email already exists") instead of axios's
// generic "Request failed with status code 400".
function toApiError(error: AxiosError): Error {
  const data = error.response?.data as { error?: unknown } | undefined
  if (data && typeof data.error === "string" && data.error.length > 0) {
    return new Error(data.error)
  }
  return error instanceof Error ? error : new Error("Request failed")
}

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

      const accessToken = await refreshAccessToken()
      if (accessToken) {
        originalRequest.headers.Authorization = `Bearer ${accessToken}`
        return api(originalRequest)
      }

      // No refresh token or refresh failed — clear auth and redirect
      logout()
    }

    return Promise.reject(toApiError(error))
  }
)

// ── Session helpers ────────────────────────────────────────────────────────
// Shared by the 401 interceptor above and the WebSocket hook (task 3.6).

// Clears auth and sends the user to the login page.
export function logout(): void {
  clearTokens()
  window.location.href = "/login"
}

// Exchanges the stored refresh token for a new token pair (and stores it).
// Returns the new access token, or null when there is no refresh token or
// the refresh failed — the caller decides whether to retry or log out.
export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return null

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
      return accessToken
    }
    return null
  } catch {
    // Refresh failed — caller logs out (catch block intentionally empty)
    return null
  }
}

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