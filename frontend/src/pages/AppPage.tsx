// frontend/src/pages/AppPage.tsx
// Updated Day 14: includes SuggestedQueries and document count in nav.

import { useState, useEffect, useCallback } from "react"
import { useNavigate }      from "react-router-dom"
import DocumentUpload       from "../components/DocumentUpload"
import DocumentList         from "../components/DocumentList"
import AgentChat            from "../components/AgentChat"
import { listDocuments }    from "../utils/api"
import { clearTokens }      from "../utils/auth"
import type { DocumentSummary, IngestionResult } from "../types"

export default function AppPage() {
  const navigate = useNavigate()

  const [documents,     setDocuments]     = useState<DocumentSummary[]>([])
  const [isLoadingDocs, setIsLoadingDocs] = useState(true)

  const loadDocuments = useCallback(async (): Promise<void> => {
    try {
      const docs = await listDocuments()
      setDocuments(docs)
    } catch (err: unknown) {
      console.error("Failed to load documents:", err)
    } finally {
      setIsLoadingDocs(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDocuments()
  }, [loadDocuments])

  const handleIngestionSuccess = useCallback(
    (result: IngestionResult): void => {
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

  const handleDocumentDelete = useCallback(
    (documentId: string): void => {
      setDocuments(prev => prev.filter(doc => doc.id !== documentId))
    },
    []
  )

  const handleLogout = (): void => {
    clearTokens()
    navigate("/login")
  }

  // Total chunks indexed across all documents
  const totalChunks = documents.reduce((sum, doc) => sum + doc.chunkCount, 0)

  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Navigation ── */}
      <nav className="sticky top-0 z-10 px-6 py-3 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between mx-auto max-w-7xl">
          <div className="flex items-center gap-3">
            <span className="text-xl">🤖</span>
            <div>
              <span className="font-bold text-slate-800">ResearchBot</span>
              <span className="ml-2 text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                ReAct Agent · pgvector · Gemini
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Infrastructure status indicators */}
            <div className="items-center hidden gap-3 text-xs md:flex text-slate-400">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full" />
                pgvector
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full" />
                Redis cache
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full" />
                Gemini API
              </span>
            </div>

            <div className="hidden w-px h-4 bg-slate-200 md:block" />

            <span className="text-xs text-slate-400">
              {documents.length} doc{documents.length !== 1 ? "s" : ""} ·{" "}
              {totalChunks.toLocaleString()} chunk{totalChunks !== 1 ? "s" : ""} indexed
            </span>

            <button
              onClick={handleLogout}
              className="text-sm transition-colors text-slate-500 hover:text-slate-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>

      {/* ── Main layout ── */}
      <main className="px-6 py-6 mx-auto max-w-7xl">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

          {/* ── Left: Document management ── */}
          <div className="space-y-4 lg:col-span-1">
            <DocumentUpload onSuccess={handleIngestionSuccess} />

            <DocumentList
              documents={documents}
              onDelete={handleDocumentDelete}
              isLoading={isLoadingDocs}
            />

            {/* ── How it works card ── */}
            <div className="p-4 bg-white border shadow-sm rounded-xl border-slate-200">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">
                ⚙️ How ResearchBot works
              </h3>
              <ol className="space-y-2 text-xs text-slate-500">
                <li className="flex gap-2">
                  <span className="flex items-center justify-center flex-shrink-0 w-5 h-5 font-bold text-blue-600 bg-blue-100 rounded-full">1</span>
                  <span><strong>Upload</strong> — text chunked into 512-char pieces</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex items-center justify-center flex-shrink-0 w-5 h-5 font-bold text-purple-600 bg-purple-100 rounded-full">2</span>
                  <span><strong>Embed</strong> — Gemini converts chunks to 768-dim vectors</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex items-center justify-center flex-shrink-0 w-5 h-5 font-bold text-green-600 bg-green-100 rounded-full">3</span>
                  <span><strong>Search</strong> — vector + keyword hybrid retrieval</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex items-center justify-center flex-shrink-0 w-5 h-5 font-bold text-orange-600 bg-orange-100 rounded-full">4</span>
                  <span><strong>Generate</strong> — Gemini answers from retrieved chunks only</span>
                </li>
              </ol>
            </div>
          </div>

          {/* ── Right: Chat ── */}
          <div className="lg:col-span-2">
            <AgentChat />
          </div>

        </div>
      </main>
    </div>
  )
}