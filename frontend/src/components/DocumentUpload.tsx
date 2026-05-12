import { useState, useRef, type ChangeEvent } from "react"
import api from "../utils/api"
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
  const [progressMessage, setProgressMessage] = useState("")  

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── File selection handler ─────────────────────────────────────────────
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return

    setName(file.name)
    setError(null)

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

  // ── Poll job status ────────────────────────────────────────────────────
  const pollJobStatus = async (jobId: string): Promise<IngestionResult> => {
    const maxAttempts = 60   // poll for up to 60 seconds
    let   attempts    = 0

    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000))   // poll every second
      attempts++

      const statusResponse = await api.get<{
        success: boolean
        data: {
          jobId:    string
          status:   string
          progress: number
          result?:  IngestionResult
          error?:   string
        } | null
      }>(`/documents/jobs/${jobId}`)

      if (!statusResponse.data.success || !statusResponse.data.data) {
        throw new Error("Failed to get job status")
      }

      const jobData = statusResponse.data.data

      setProgressMessage(
        `Processing... ${jobData.progress}%` +
        (jobData.status === "active" ? " (chunking & embedding)" : "")
      )

      if (jobData.status === "completed" && jobData.result) {
        return jobData.result
      }

      if (jobData.status === "failed") {
        throw new Error(jobData.error ?? "Ingestion failed")
      }
    }

    throw new Error("Ingestion timed out after 60 seconds")
  }

  // ── Form submission (async ingestion) ──────────────────────────────────
  const handleSubmit = async (): Promise<void> => {
    setError(null)
    setLastResult(null)

    if (!name.trim()) { setError("Please provide a document name."); return }
    if (!content.trim()) { setError("Document content cannot be empty."); return }
    if (content.length > 500_000) {
      setError(`Document is too large. Maximum is 500KB.`); return
    }

    setIsLoading(true)

    try {
      // Step 1: Queue the ingestion job (returns immediately)
      const queueResponse = await api.post<{
        success: boolean
        data: { jobId: string; status: string; name: string } | null
        error: string | null
      }>("/documents/ingest", {
        name:     name.trim(),
        content,
        mimeType: "text/plain"
      })

      if (!queueResponse.data.success || !queueResponse.data.data) {
        throw new Error(queueResponse.data.error ?? "Failed to queue document")
      }

      const { jobId } = queueResponse.data.data
      setProgressMessage("Queued — waiting for worker...")

      // Step 2: Poll for job completion
      const result = await pollJobStatus(jobId)

      setLastResult(result)
      onSuccess(result)

      setName("")
      setContent("")
      if (fileInputRef.current) fileInputRef.current.value = ""

    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to ingest document.")
    } finally {
      setIsLoading(false)
      setProgressMessage("")
    }
  }

  return (
    <div className="p-5 bg-white border shadow-sm rounded-xl border-slate-200">
      <h2 className="mb-4 text-lg font-semibold text-slate-800">
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
        <label className="block mb-1 text-sm font-medium text-slate-700">
          Document name
        </label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Q3-Report.txt"
          className="w-full px-3 py-2 text-sm border rounded-lg border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      {/* ── Content input ── */}
      {mode === "paste" ? (
        <div className="mb-4">
          <label className="block mb-1 text-sm font-medium text-slate-700">
            Document content
          </label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Paste your document text here..."
            rows={8}
            className="w-full px-3 py-2 font-mono text-sm border rounded-lg resize-none border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="mt-1 text-xs text-slate-400">
            {content.length.toLocaleString()} characters
            {content.length > 0 && ` (~${Math.ceil(content.length / 4).toLocaleString()} tokens)`}
          </p>
        </div>
      ) : (
        <div className="mb-4">
          <label className="block mb-1 text-sm font-medium text-slate-700">
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
            <p className="mt-1 text-xs text-green-600">
              ✅ {content.length.toLocaleString()} characters loaded
            </p>
          )}
        </div>
      )}

      {/* ── Error message ── */}
      {error && (
        <div className="p-3 mb-3 border border-red-200 rounded-lg bg-red-50">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* ── Success message ── */}
      {lastResult && (
        <div className="p-3 mb-3 border border-green-200 rounded-lg bg-green-50">
          <p className="text-sm font-medium text-green-700">
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
            <span className="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin" />
            {progressMessage || "Ingesting..."}
          </>
        ) : (
          "Ingest Document"
        )}
      </button>

      <p className="mt-2 text-xs text-center text-slate-400">
        Document will be chunked, embedded, and stored in pgvector
      </p>
    </div>
  )
}