// frontend/src/pages/AppPage.tsx
// The main application page after login.
// Two-column layout: documents panel (left) + chat (right).

import { useState, useEffect, useCallback } from "react"
import { useNavigate }    from "react-router-dom"
import DocumentUpload     from "../components/DocumentUpload"
import DocumentList       from "../components/DocumentList"
import AgentChat          from "../components/AgentChat"
import { listDocuments }  from "../utils/api"
import { clearTokens }    from "../utils/auth"
import type { DocumentSummary, IngestionResult } from "../types"

export default function AppPage() {
  const navigate = useNavigate()

  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [isLoadingDocs, setIsLoadingDocs] = useState(true)

  useEffect(() => {
    let isMounted = true

    const fetchDocuments = async () => {
      try {
        const docs = await listDocuments()
        if (isMounted) {
          setDocuments(docs)
          setIsLoadingDocs(false)
        }
      } catch (err: unknown) {
        console.error("Failed to load documents:", err)
        if (isMounted) {
          setIsLoadingDocs(false)
        }
      }
    }

    fetchDocuments()

    return () => {
      isMounted = false
    }
  }, []) // Empty dependency array – runs once on mount

  // ── Handle successful ingestion ────────────────────────────────────────
  const handleIngestionSuccess = useCallback(
    (result: IngestionResult): void => {
      // Add a placeholder document to the list immediately
      // (without a full reload) using the ingestion result
      const newDoc: DocumentSummary = {
        id:         result.documentId,
        name:       result.name,
        mimeType:   "text/plain",
        sizeBytes:  0,
        userId:     "",
        createdAt:  new Date().toISOString(),
        updatedAt:  new Date().toISOString(),
        chunkCount: result.chunkCount
      }

      setDocuments(prev => [newDoc, ...prev])
    },
    []
  )

  // ── Handle document deletion ───────────────────────────────────────────
  const handleDocumentDelete = useCallback(
    (documentId: string): void => {
      setDocuments(prev => prev.filter(doc => doc.id !== documentId))
    },
    []
  )

  // ── Logout ─────────────────────────────────────────────────────────────
  const handleLogout = (): void => {
    clearTokens()
    navigate("/login")
  }

  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Navigation bar ── */}
      <nav className="bg-white border-b border-slate-200 px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🤖</span>
            <span className="font-bold text-slate-800">ResearchBot</span>
            <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full ml-1">
              RAG + pgvector
            </span>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-xs text-slate-400">
              {documents.length} document{documents.length !== 1 ? "s" : ""} indexed
            </span>
            <button
              onClick={handleLogout}
              className="text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>

      {/* ── Main content ── */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* ── Left panel: Documents ── */}
          <div className="lg:col-span-1 space-y-4">
            <DocumentUpload onSuccess={handleIngestionSuccess} />
            <DocumentList
              documents={documents}
              onDelete={handleDocumentDelete}
              isLoading={isLoadingDocs}
            />
          </div>

          {/* ── Right panel: Chat ── */}
          <div className="lg:col-span-2">
            <AgentChat />
          </div>

        </div>
      </main>
    </div>
  )
}
