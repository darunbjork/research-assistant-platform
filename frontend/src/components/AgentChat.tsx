// frontend/src/components/AgentChat.tsx
// The main chat interface for ResearchBot.
// Manages the message history, agent status, and API calls.
//
// STATE MANAGEMENT:
//   messages:     the full chat history (user + agent messages)
//   inputValue:   the current text in the input field
//   agentStatus:  current pipeline stage (idle → thinking → searching → generating → done)
//   error:        any error that occurred during the pipeline
//
// PIPELINE SIMULATION:
// We cannot stream status updates without WebSocket (Day 16).
// For now, we simulate the stages with setTimeout delays
// so the UI shows meaningful status transitions.

import { useState, useRef, useEffect } from "react"
import { queryRag } from "../utils/api"
import MessageCard from "./MessageCard"
import AgentStatusBadge from "./AgentStatusBadge"
import type { ChatMessage, AgentStatus } from "../types"

// Simple UUID generator — does not require a library
function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour:   "2-digit",
    minute: "2-digit"
  })
}

// Welcome message shown before any user interaction
const WELCOME_MESSAGE: ChatMessage = {
  id:        "welcome",
  text: `Hello! I'm ResearchBot 🤖

I can answer questions about the documents you've uploaded. My answers are grounded in the actual document content — I'll show you exactly which sources I used.

Upload a document on the left, then ask me anything about it!`,
  sender:    "agent",
  timestamp: formatTime(new Date()),
  citations: []
}

export default function AgentChat() {
  const [messages,    setMessages]    = useState<ChatMessage[]>([WELCOME_MESSAGE])
  const [inputValue,  setInputValue]  = useState("")
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle")
  const [error,       setError]       = useState<string | null>(null)

  // Ref for auto-scrolling to the latest message
  const bottomRef   = useRef<HTMLDivElement>(null)
  const inputRef    = useRef<HTMLInputElement>(null)

  // Auto-scroll whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const isDisabled = agentStatus !== "idle"

  // ── Send a message ─────────────────────────────────────────────────────
  const handleSend = async (): Promise<void> => {
    const query = inputValue.trim()
    if (!query || isDisabled) return

    setError(null)
    setInputValue("")

    // Add user message to chat immediately
    const userMessage: ChatMessage = {
      id:        generateId(),
      text:      query,
      sender:    "user",
      timestamp: formatTime(new Date())
    }

    setMessages(prev => [...prev, userMessage])

    // ── Simulate pipeline stages ─────────────────────────────────────
    // Real-time streaming will replace this on Day 16 (WebSocket).
    // For now, we show each stage for a minimum duration
    // so the user can see the system is working.
    setAgentStatus("thinking")

    // Small delay before showing "searching" so user can read "thinking"
    await new Promise(resolve => setTimeout(resolve, 400))
    setAgentStatus("searching")

    try {
      // ── Call the RAG pipeline ──────────────────────────────────────
      // This is the real API call — it takes 1-3 seconds
      const startTime = Date.now()
      const result    = await queryRag(query, 10)

      // Show "generating" for at least 300ms after search completes
      setAgentStatus("generating")
      const elapsed = Date.now() - startTime
      if (elapsed < 700) {
        await new Promise(resolve => setTimeout(resolve, 700 - elapsed))
      }

      // ── Add agent response to chat ─────────────────────────────────
      const agentMessage: ChatMessage = {
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

      setMessages(prev => [...prev, agentMessage])
      setAgentStatus("done")

      // Reset to idle after 1.5 seconds
      setTimeout(() => setAgentStatus("idle"), 1500)

    } catch (err: unknown) {
      const message = err instanceof Error
        ? err.message
        : "An unexpected error occurred. Is the backend server running?"

      setError(message)
      setAgentStatus("error")

      // Add error message to chat
      const errorMessage: ChatMessage = {
        id:        generateId(),
        text:      `Sorry, I encountered an error: ${message}`,
        sender:    "agent",
        timestamp: formatTime(new Date()),
        status:    "error"
      }

      setMessages(prev => [...prev, errorMessage])

      // Reset to idle after 3 seconds
      setTimeout(() => {
        setAgentStatus("idle")
        setError(null)
      }, 3000)
    }

    // Re-focus the input after the response
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  // ── Handle Enter key ───────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // ── Clear chat ─────────────────────────────────────────────────────────
  const handleClear = (): void => {
    setMessages([WELCOME_MESSAGE])
    setAgentStatus("idle")
    setError(null)
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col h-175">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">
            🤖 ResearchBot
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Ask questions about your uploaded documents
          </p>
        </div>

        <div className="flex items-center gap-3">
          <AgentStatusBadge status={agentStatus} />

          <button
            onClick={handleClear}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto px-5 py-4 chat-scroll">
        {messages.map(message => (
          <MessageCard key={message.id} message={message} />
        ))}

        {/* Typing indicator while agent is working */}
        {isDisabled && agentStatus !== "done" && agentStatus !== "error" && (
          <div className="flex justify-start mb-4">
            <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        {/* Auto-scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="mx-5 mb-2 p-2 bg-red-50 border border-red-200 rounded-lg">
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
            placeholder={
              isDisabled
                ? "ResearchBot is working..."
                : "Ask a question about your documents..."
            }
            disabled={isDisabled}
            className="flex-1 px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-slate-50 disabled:text-slate-400 transition-colors"
          />

          <button
            onClick={() => void handleSend()}
            disabled={isDisabled || !inputValue.trim()}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-xl text-sm transition-colors flex items-center gap-1.5"
          >
            {isDisabled ? (
              <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
            ) : (
              "Send →"
            )}
          </button>
        </div>

        <p className="text-xs text-slate-400 mt-1.5 text-center">
          Press Enter to send · Answers are grounded in your documents
        </p>
      </div>
    </div>
  )
}
