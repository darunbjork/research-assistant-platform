// frontend/src/components/DocumentUpload.tsx
// Allows users to paste text content or upload a .txt file for ingestion.
//
// TWO UPLOAD MODES:
// 1. PASTE: User pastes text content directly into a textarea
// 2. FILE:  User selects a .txt file — content is read via FileReader API
//
// After successful ingestion, calls onSuccess(result) so the parent
// can update the document list without a full page refresh.

import { useState, useRef, type ChangeEvent } from "react"
import { ingestDocument } from "../utils/api"
import type { IngestionResult } from "../types"

interface Props {
  onSuccess: (result: IngestionResult) => void
}

type UploadMode = "paste" | "file"

export default function DocumentUpload({ onSuccess }: Props) {
  const [mode,         setMode]         = useState<UploadMode>("paste")
  const [name,         setName]         = useState("")
  const [content,      setContent]      = useState("")
  const [isLoading,    setIsLoading]    = useState(false)
  const [error,        setError]        = useState<string | null>(null)
  const [lastResult,   setLastResult]   = useState<IngestionResult | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── File selection handler ─────────────────────────────────────────────
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return

    // Pre-fill the name field with the filename
    setName(file.name)
    setError(null)

    // Read file content as text using the FileReader API
    const reader = new FileReader()

    reader.onload = event => {
      const text = event.target?.result
      if (typeof text === "string") {
        setContent(text)
      }
    }

    reader.onerror = () => {
      setError("Failed to read the file. Please try again.")
    }

    reader.readAsText(file)
  }

  // ── Form submission ────────────────────────────────────────────────────
  const handleSubmit = async (): Promise<void> => {
    setError(null)
    setLastResult(null)

    // Validation
    if (!name.trim()) {
      setError("Please provide a document name.")
      return
    }

    if (!content.trim()) {
      setError("Document content cannot be empty.")
      return
    }

    if (content.length > 500_000) {
      setError(
        `Document is too large (${Math.round(content.length / 1000)}KB). ` +
        `Maximum is 500KB.`
      )
      return
    }

    setIsLoading(true)

    try {
      const result = await ingestDocument(
        name.trim(),
        content,
        "text/plain"
      )

      setLastResult(result)
      onSuccess(result)

      // Reset form after successful upload
      setName("")
      setContent("")
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }

    } catch (err: unknown) {
      const message = err instanceof Error
        ? err.message
        : "Failed to ingest document. Is the server running?"
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      <h2 className="text-lg font-semibold text-slate-800 mb-4">
        📄 Upload Document
      </h2>

      {/* ── Mode selector ── */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => { setMode("paste"); setError(null) }}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === "paste"
              ? "bg-blue-600 text-white"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          Paste text
        </button>
        <button
          onClick={() => { setMode("file"); setError(null) }}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === "file"
              ? "bg-blue-600 text-white"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          Upload .txt file
        </button>
      </div>

      {/* ── Document name ── */}
      <div className="mb-3">
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Document name
        </label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Q3-Report.txt"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      {/* ── Content input ── */}
      {mode === "paste" ? (
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Document content
          </label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Paste your document text here..."
            rows={8}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none font-mono"
          />
          <p className="text-xs text-slate-400 mt-1">
            {content.length.toLocaleString()} characters
            {content.length > 0 && ` (~${Math.ceil(content.length / 4).toLocaleString()} tokens)`}
          </p>
        </div>
      ) : (
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Select a .txt file
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.csv"
            onChange={handleFileChange}
            className="w-full text-sm text-slate-500 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
          {content && (
            <p className="text-xs text-green-600 mt-1">
              ✅ {content.length.toLocaleString()} characters loaded
            </p>
          )}
        </div>
      )}

      {/* ── Error message ── */}
      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* ── Success message ── */}
      {lastResult && (
        <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-700 font-medium">
            ✅ "{lastResult.name}" ingested successfully
          </p>
          <p className="text-xs text-green-600 mt-0.5">
            {lastResult.chunkCount} chunks · {lastResult.tokenCount.toLocaleString()} tokens · {lastResult.durationMs}ms
          </p>
        </div>
      )}

      {/* ── Submit button ── */}
      <button
        onClick={() => void handleSubmit()}
        disabled={isLoading}
        className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-medium rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
      >
        {isLoading ? (
          <>
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Ingesting...
          </>
        ) : (
          "Ingest Document"
        )}
      </button>

      <p className="text-xs text-slate-400 mt-2 text-center">
        Document will be chunked, embedded, and stored in pgvector
      </p>
    </div>
  )
}
