// frontend/src/components/AgentChat.tsx
// Updated Day 14: switched from simple RAG to full autonomous agent.
// Now calls /api/v1/agent/chat and displays reasoning steps.
//
// KEY CHANGES FROM DAY 12:
// 1. Uses queryAgent() instead of queryRag()
// 2. Maps AgentResult.steps → ChatMessage.agentSteps
// 3. Status transitions match the ReAct loop stages
// 4. Metadata includes iterationCount
// 5. Mode toggle: Simple RAG vs Full Agent

import { useState, useRef, useEffect } from "react"
import { queryAgent, queryRag }        from "../utils/api"
import MessageCard                     from "./MessageCard"
import AgentStatusBadge               from "./AgentStatusBadge"
import type { ChatMessage, AgentStatus } from "../types"

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour:   "2-digit",
    minute: "2-digit"
  })
}

type ChatMode = "agent" | "rag"

const WELCOME_MESSAGE: ChatMessage = {
  id:        "welcome",
  text:      "Hello! I'm ResearchBot 🤖\n\n" +
             "I can answer questions about your uploaded documents using two modes:\n\n" +
             "🤖 **Agent mode** (default): I reason step-by-step, searching multiple times if needed, and can do calculations.\n\n" +
             "⚡ **RAG mode**: Faster single-pass retrieval — best for simple direct questions.\n\n" +
             "Upload a document on the left and ask me anything!",
  sender:    "agent",
  timestamp: formatTime(new Date()),
  citations: []
}

export default function AgentChat() {
  const [messages,    setMessages]    = useState<ChatMessage[]>([WELCOME_MESSAGE])
  const [inputValue,  setInputValue]  = useState("")
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle")
  const [error,       setError]       = useState<string | null>(null)
  const [mode,        setMode]        = useState<ChatMode>("agent")

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const isDisabled = agentStatus !== "idle"

  // ── Pipeline stage simulation for Agent mode ───────────────────────────
  // The real stages happen on the backend.
  // We simulate them on the frontend to show meaningful status transitions.
  // Day 16 (WebSocket) replaces this with real-time streaming.
  const simulateAgentStages = async (): Promise<void> => {
    setAgentStatus("thinking")
    await new Promise(r => setTimeout(r, 350))
    setAgentStatus("searching")
    await new Promise(r => setTimeout(r, 400))
    // Stay in "searching" while the actual API call runs
  }

  // ── Send message ───────────────────────────────────────────────────────
  const handleSend = async (): Promise<void> => {
    const query = inputValue.trim()
    if (!query || isDisabled) return

    setError(null)
    setInputValue("")

    // Add user message immediately
    const userMessage: ChatMessage = {
      id:        generateId(),
      text:      query,
      sender:    "user",
      timestamp: formatTime(new Date())
    }
    setMessages(prev => [...prev, userMessage])

    if (mode === "agent") {
      await handleAgentQuery(query)
    } else {
      await handleRagQuery(query)
    }

    setTimeout(() => inputRef.current?.focus(), 100)
  }

  // ── Agent mode: full ReAct loop ────────────────────────────────────────
  const handleAgentQuery = async (query: string): Promise<void> => {
    // Start simulating pipeline stages
    void simulateAgentStages()

    try {
      const result = await queryAgent(query)

      // Show "generating" briefly after search completes
      setAgentStatus("generating")
      await new Promise(r => setTimeout(r, 300))

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
      setAgentStatus("done")
      setTimeout(() => setAgentStatus("idle"), 1500)

    } catch (err: unknown) {
      handleError(err)
    }
  }

  // ── RAG mode: single-pass retrieval ────────────────────────────────────
  const handleRagQuery = async (query: string): Promise<void> => {
    setAgentStatus("thinking")
    await new Promise(r => setTimeout(r, 200))
    setAgentStatus("searching")

    try {
      const result = await queryRag(query)

      setAgentStatus("generating")
      await new Promise(r => setTimeout(r, 300))

      const ragMessage: ChatMessage = {
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
      }

      setMessages(prev => [...prev, ragMessage])
      setAgentStatus("done")
      setTimeout(() => setAgentStatus("idle"), 1500)

    } catch (err: unknown) {
      handleError(err)
    }
  }

  // ── Error handling ─────────────────────────────────────────────────────
  const handleError = (err: unknown): void => {
    const message = err instanceof Error
      ? err.message
      : "An unexpected error occurred. Is the backend server running?"

    setError(message)
    setAgentStatus("error")

    const errorMessage: ChatMessage = {
      id:        generateId(),
      text:      `Sorry, I encountered an error: ${message}`,
      sender:    "agent",
      timestamp: formatTime(new Date()),
      status:    "error"
    }

    setMessages(prev => [...prev, errorMessage])

    setTimeout(() => {
      setAgentStatus("idle")
      setError(null)
    }, 3000)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const handleClear = (): void => {
    setMessages([WELCOME_MESSAGE])
    setAgentStatus("idle")
    setError(null)
  }

  // ── Placeholder text based on current state ────────────────────────────
  const getPlaceholder = (): string => {
    if (isDisabled) return "ResearchBot is working..."
    if (mode === "agent") return "Ask anything — I'll reason step by step..."
    return "Ask a direct question about your documents..."
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col h-[700px]">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">
            🤖 ResearchBot
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Grounded answers · Source citations · Reasoning transparency
          </p>
        </div>

        <div className="flex items-center gap-3">
          <AgentStatusBadge status={agentStatus} />

          <button
            onClick={handleClear}
            className="text-xs transition-colors text-slate-400 hover:text-slate-600"
          >
            Clear
          </button>
        </div>
      </div>

      {/* ── Mode Toggle ── */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-slate-100">
        <span className="text-xs font-medium text-slate-500">Mode:</span>

        <div className="flex gap-1 bg-slate-100 p-0.5 rounded-lg">
          <button
            onClick={() => setMode("agent")}
            disabled={isDisabled}
            className={`
              px-3 py-1 rounded-md text-xs font-medium transition-colors
              ${mode === "agent"
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
              }
              disabled:opacity-50 disabled:cursor-not-allowed
            `}
          >
            🤖 Agent (ReAct)
          </button>
          <button
            onClick={() => setMode("rag")}
            disabled={isDisabled}
            className={`
              px-3 py-1 rounded-md text-xs font-medium transition-colors
              ${mode === "rag"
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
              }
              disabled:opacity-50 disabled:cursor-not-allowed
            `}
          >
            ⚡ RAG (Direct)
          </button>
        </div>

        <span className="text-xs text-slate-400">
          {mode === "agent"
            ? "Multi-step reasoning · up to 5 iterations"
            : "Single-pass retrieval · faster"
          }
        </span>
      </div>

      {/* ── Message list ── */}
      <div className="flex-1 px-5 py-4 overflow-y-auto chat-scroll">
        {messages.map(message => (
          <MessageCard key={message.id} message={message} />
        ))}

        {/* Typing indicator */}
        {isDisabled && agentStatus !== "done" && agentStatus !== "error" && (
          <div className="flex justify-start mb-4">
            <div className="px-4 py-3 bg-white border rounded-bl-sm shadow-sm border-slate-200 rounded-2xl">
              <div className="flex items-center gap-1">
                <div
                  className="w-2 h-2 rounded-full bg-slate-400 animate-bounce"
                  style={{ animationDelay: "0ms" }}
                />
                <div
                  className="w-2 h-2 rounded-full bg-slate-400 animate-bounce"
                  style={{ animationDelay: "150ms" }}
                />
                <div
                  className="w-2 h-2 rounded-full bg-slate-400 animate-bounce"
                  style={{ animationDelay: "300ms" }}
                />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="p-2 mx-5 mb-2 border border-red-200 rounded-lg bg-red-50">
          <p className="text-xs text-red-700">{error}</p>
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
            placeholder={getPlaceholder()}
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
            ) : (
              <>
                Send
                <span className="hidden sm:inline">→</span>
              </>
            )}
          </button>
        </div>

        <p className="text-xs text-slate-400 mt-1.5 text-center">
          Enter to send · Expand "reasoning steps" to verify sources
        </p>
      </div>
    </div>
  )
}