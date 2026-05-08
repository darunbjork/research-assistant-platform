// frontend/src/components/DocumentList.tsx
// Shows the list of ingested documents with their chunk counts.
// Allows deletion of individual documents.

import { useState } from "react"
import { deleteDocument } from "../utils/api"
import type { DocumentSummary } from "../types"

interface Props {
  documents:  DocumentSummary[]
  onDelete:   (documentId: string) => void
  isLoading:  boolean
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024)         return `${bytes}B`
  if (bytes < 1024 * 1024)  return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day:   "numeric",
    year:  "numeric"
  })
}

export default function DocumentList({ documents, onDelete, isLoading }: Props) {
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleDelete = async (documentId: string, name: string): Promise<void> => {
    if (!confirm(`Delete "${name}"? This will remove all ${documents.find(d => d.id === documentId)?.chunkCount ?? 0} chunks from pgvector.`)) {
      return
    }

    setDeletingId(documentId)

    try {
      await deleteDocument(documentId)
      onDelete(documentId)
    } catch (err: unknown) {
      console.error("Delete failed:", err)
      alert("Failed to delete document. Please try again.")
    } finally {
      setDeletingId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <h2 className="text-lg font-semibold text-slate-800 mb-4">
          📚 Your Documents
        </h2>
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      <h2 className="text-lg font-semibold text-slate-800 mb-4">
        📚 Your Documents
        {documents.length > 0 && (
          <span className="ml-2 text-sm font-normal text-slate-400">
            ({documents.length})
          </span>
        )}
      </h2>

      {documents.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-slate-400 text-sm">No documents yet.</p>
          <p className="text-slate-400 text-xs mt-1">
            Upload a document above to start asking questions.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {documents.map(doc => (
            <div
              key={doc.id}
              className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100 hover:border-slate-200 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-700 truncate">
                  📄 {doc.name}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-slate-400">
                    {doc.chunkCount} chunks
                  </span>
                  <span className="text-xs text-slate-300">·</span>
                  <span className="text-xs text-slate-400">
                    {formatFileSize(doc.sizeBytes)}
                  </span>
                  <span className="text-xs text-slate-300">·</span>
                  <span className="text-xs text-slate-400">
                    {formatDate(doc.createdAt)}
                  </span>
                </div>
              </div>

              <button
                onClick={() => void handleDelete(doc.id, doc.name)}
                disabled={deletingId === doc.id}
                className="ml-3 text-xs text-red-400 hover:text-red-600 disabled:opacity-50 transition-colors shrink-0"
              >
                {deletingId === doc.id ? "Deleting..." : "Delete"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
