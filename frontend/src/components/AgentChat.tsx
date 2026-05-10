import { useState, useRef, useEffect }  from "react"
import { queryAgent }         from "../utils/api"
import { useAgentWebSocket }            from "../hooks/useAgentWebSocket"
import MessageCard                      from "./MessageCard"
import AgentStatusBadge                 from "./AgentStatusBadge"
import type { ChatMessage, AgentStatus } from "../types"

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

type ChatMode = "ws-agent" | "http-agent" | "rag" | "rag-rerank"

const WELCOME_MESSAGE: ChatMessage = {
  id:        "welcome",
  text:
    "Hello! I'm ResearchBot 🤖\n\n" +
    "I use real-time WebSocket streaming to show you my reasoning as it happens.\n\n" +
    "Upload a document and ask me anything — watch me think step by step!",
  sender:    "agent",
  timestamp: formatTime(new Date()),
  citations: []
}

export default function AgentChat() {
  const [messages,   setMessages]   = useState<ChatMessage[]>([WELCOME_MESSAGE])
  const [inputValue, setInputValue] = useState("")
  const [chatMode,   setChatMode]   = useState<ChatMode>("ws-agent")
  const [httpStatus, setHttpStatus] = useState<AgentStatus>("idle")

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)

  // ── WebSocket hook ─────────────────────────────────────────────────────
  const ws = useAgentWebSocket()

  // Auto-scroll when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // ── Watch for completed WebSocket responses ────────────────────────────
  // When finalAnswer arrives via WebSocket, add it to the chat
  const lastFinalAnswer = useRef("")

  useEffect(() => {
    if (
      ws.finalAnswer &&
      ws.finalAnswer !== lastFinalAnswer.current &&
      chatMode === "ws-agent"
    ) {
      lastFinalAnswer.current = ws.finalAnswer

      const agentMessage: ChatMessage = {
        id:          generateId(),
        text:        ws.finalAnswer,
        sender:      "agent",
        timestamp:   formatTime(new Date()),
        citations:   ws.citations,
        agentSteps:  ws.steps,
        status:      "done",
        metadata: {
          chunksRetrieved: ws.citations.length,
          tokensUsed:      0,
          durationMs:      0,
          iterationCount:  ws.steps.filter(s => s.toolUsed).length
        }
      }

      setMessages(prev => [...prev, agentMessage])
    }
  }, [ws.finalAnswer, ws.citations, ws.steps, chatMode])

  // ── Determine active status ────────────────────────────────────────────
  const activeStatus: AgentStatus = chatMode === "ws-agent" ? ws.agentStatus : httpStatus
  const isDisabled = chatMode === "ws-agent" ? ws.isRunning : httpStatus !== "idle"

  // ── Send handler ───────────────────────────────────────────────────────
  const handleSend = async (): Promise<void> => {
    const query = inputValue.trim()
    if (!query || isDisabled) return

    setInputValue("")

    // Add user message
    const userMessage: ChatMessage = {
      id:        generateId(),
      text:      query,
      sender:    "user",
      timestamp: formatTime(new Date())
    }
    setMessages(prev => [...prev, userMessage])

    if (chatMode === "ws-agent") {
      // WebSocket mode — streaming
      ws.startQuery(query)
    } else if (chatMode === "http-agent") {
      // HTTP Agent mode (fallback)
      await handleHttpAgent(query)
    } else if (chatMode === "rag-rerank") {
      // RAG+Rerank mode
      await handleRagRerank(query)
    } else {
      // RAG mode
      await handleRagQuery(query)
    }

    setTimeout(() => inputRef.current?.focus(), 100)
  }

  const handleHttpAgent = async (query: string): Promise<void> => {
    setHttpStatus("thinking")
    await new Promise(r => setTimeout(r, 300))
    setHttpStatus("searching")

    try {
      const result = await queryAgent(query)
      setHttpStatus("generating")
      await new Promise(r => setTimeout(r, 200))

      const agentMessage: ChatMessage = {
        id:          generateId(),
        text:        result.finalAnswer,
        sender:      "agent",
        timestamp:   formatTime(new Date()),
        citations:   result.citations,
        agentSteps:  result.steps,
        status:      "done",
        metadata: {
          chunksRetrieved: result.citations.length,
          tokensUsed:      result.tokensUsed,
          durationMs:      result.durationMs,
          iterationCount:  result.iterationCount
        }
      }

      setMessages(prev => [...prev, agentMessage])
      setHttpStatus("done")
      setTimeout(() => setHttpStatus("idle"), 1500)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Request failed"
      setMessages(prev => [...prev, {
        id: generateId(), text: `Error: ${message}`,
        sender: "agent", timestamp: formatTime(new Date()), status: "error"
      }])
      setHttpStatus("error")
      setTimeout(() => setHttpStatus("idle"), 2000)
    }
  }

  const handleRagQuery = async (query: string): Promise<void> => {
    setHttpStatus("searching")
    try {
      const { queryRag: qr } = await import("../utils/api")
      const result = await qr(query)
      setHttpStatus("done")

      setMessages(prev => [...prev, {
        id:        generateId(),
        text:      result.answer,
        sender:    "agent",
        timestamp: formatTime(new Date()),
        citations: result.citations,
        status:    "done",
        metadata: {
          chunksRetrieved: result.chunksRetrieved,
          tokensUsed:      result.tokensUsed,
          durationMs:      result.durationMs
        }
      }])

      setTimeout(() => setHttpStatus("idle"), 1500)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Request failed"
      setMessages(prev => [...prev, {
        id: generateId(), text: `Error: ${message}`,
        sender: "agent", timestamp: formatTime(new Date()), status: "error"
      }])
      setHttpStatus("error")
      setTimeout(() => setHttpStatus("idle"), 2000)
    }
  }

  const handleRagRerank = async (query: string): Promise<void> => {
    setHttpStatus("searching")
    try {
      const response = await import("../utils/api").then(m =>
        m.default.post<import("../types").ApiResult<{
          answer: string
          citations: import("../types").Citation[]
          chunksRetrieved: number
          chunksReranked: number
          tokensUsed: number
          durationMs: number
        }>>("/rag/query-with-rerank", { query, topK: 5 })
      )

      if (!response.data.success || !response.data.data) {
        throw new Error(response.data.error ?? "Reranked RAG failed")
      }

      const result = response.data.data
      setHttpStatus("done")

      setMessages(prev => [...prev, {
        id:        generateId(),
        text:      result.answer,
        sender:    "agent" as const,
        timestamp: formatTime(new Date()),
        citations: result.citations,
        status:    "done" as const,
        metadata: {
          chunksRetrieved: result.chunksRetrieved,
          tokensUsed:      result.tokensUsed,
          durationMs:      result.durationMs
        }
      }])

      setTimeout(() => setHttpStatus("idle"), 1500)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Request failed"
      setMessages(prev => [...prev, {
        id: generateId(), text: `Error: ${msg}`,
        sender: "agent" as const, timestamp: formatTime(new Date()), status: "error" as const
      }])
      setHttpStatus("error")
      setTimeout(() => setHttpStatus("idle"), 2000)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // ── WebSocket connection status indicator ──────────────────────────────
  const wsIndicator = {
    disconnected: { dot: "bg-red-400",    label: "Disconnected" },
    connecting:   { dot: "bg-yellow-400 animate-pulse", label: "Connecting..." },
    connected:    { dot: "bg-yellow-400 animate-pulse", label: "Authenticating..." },
    authenticated:{ dot: "bg-green-400",  label: "WebSocket live" },
    error:        { dot: "bg-red-400",    label: "WS error — using HTTP" }
  }[ws.connectionState]

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col h-[700px]">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">🤖 ResearchBot</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${wsIndicator.dot}`} />
            <span className="text-xs text-slate-400">{wsIndicator.label}</span>
          </div>
        </div>
        <AgentStatusBadge status={activeStatus} />
      </div>

      {/* ── Mode Toggle ── */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-slate-100">
        <span className="text-xs font-medium text-slate-500">Mode:</span>
        <div className="flex gap-1 bg-slate-100 p-0.5 rounded-lg">
          {(["ws-agent", "http-agent", "rag", "rag-rerank"] as ChatMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setChatMode(mode)}
              disabled={isDisabled}
              className={`
                px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                ${chatMode === mode
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
                }
                disabled:opacity-50 disabled:cursor-not-allowed
              `}
            >
              {mode === "ws-agent"    && "🔌 Agent (WS)"}
              {mode === "http-agent"  && "🤖 Agent (HTTP)"}
              {mode === "rag"         && "⚡ RAG"}
              {mode === "rag-rerank"  && "🎯 RAG+Rerank"}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-400">
          {chatMode === "ws-agent"   && "Real-time streaming · WebSocket"}
          {chatMode === "http-agent" && "Multi-step reasoning · HTTP"}
          {chatMode === "rag-rerank" && "Hybrid search + cross-encoder reranking"}
        </span>
      </div>

      {/* ── Live streaming steps (WebSocket mode only) ── */}
      {chatMode === "ws-agent" && ws.isRunning && ws.steps.length > 0 && (
        <div className="px-5 py-2 border-b border-slate-100 bg-slate-50">
          <p className="text-xs text-slate-500 font-medium mb-1.5">
            Live reasoning steps:
          </p>
          <div className="space-y-1 overflow-y-auto max-h-28">
            {ws.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-slate-600">
                <span className="flex-shrink-0 font-mono text-slate-400">{step.stepNumber}.</span>
                <span>
                  {step.toolUsed === "rag_search" && "🔍 "}
                  {step.toolUsed === "calculator" && "🧮 "}
                  {!step.toolUsed && step.description.includes("Quality") && "📊 "}
                  {!step.toolUsed && !step.description.includes("Quality") && "💭 "}
                  {step.description}
                  {step.durationMs > 0 && (
                    <span className="ml-1 text-slate-400">({step.durationMs}ms)</span>
                  )}
                </span>
              </div>
            ))}
          </div>

          {ws.qualityScore !== null && (
            <div className="mt-1.5 text-xs text-teal-600 font-medium">
              📊 Quality score: {(ws.qualityScore * 100).toFixed(0)}%
            </div>
          )}
        </div>
      )}

      {/* ── Message list ── */}
      <div className="flex-1 px-5 py-4 overflow-y-auto chat-scroll">
        {messages.map(message => (
          <MessageCard key={message.id} message={message} />
        ))}

        {/* Typing indicator */}
        {isDisabled && activeStatus !== "done" && activeStatus !== "error" && (
          <div className="flex justify-start mb-4">
            <div className="px-4 py-3 bg-white border rounded-bl-sm shadow-sm border-slate-200 rounded-2xl">
              <div className="flex items-center gap-1">
                {[0, 150, 300].map(delay => (
                  <div
                    key={delay}
                    className="w-2 h-2 rounded-full bg-slate-400 animate-bounce"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Error banner ── */}
      {(ws.error ?? null) && (
        <div className="p-2 mx-5 mb-2 border border-red-200 rounded-lg bg-red-50">
          <p className="text-xs text-red-700">{ws.error}</p>
        </div>
      )}

      {/* ── Input area ── */}
      <div className="px-5 py-4 border-t border-slate-100">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isDisabled
                ? "ResearchBot is working..."
                : ws.connectionState !== "authenticated" && chatMode === "ws-agent"
                  ? "Connecting to WebSocket..."
                  : "Ask a question about your documents..."
            }
            disabled={isDisabled}
            className="flex-1 px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-slate-50 disabled:text-slate-400 transition-colors"
          />
          <button
            onClick={() => void handleSend()}
            disabled={isDisabled || !inputValue.trim()}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-xl text-sm transition-colors flex items-center gap-1.5 flex-shrink-0"
          >
            {isDisabled ? (
              <span className="w-4 h-4 border-2 rounded-full border-slate-400 border-t-transparent animate-spin" />
            ) : "Send →"}
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-1.5 text-center">
          {chatMode === "ws-agent"
            ? "WebSocket streaming · steps appear in real time"
            : "Enter to send · answers grounded in your documents"
          }
        </p>
      </div>
    </div>
  )
}