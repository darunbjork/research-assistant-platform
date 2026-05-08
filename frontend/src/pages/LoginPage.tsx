// frontend/src/pages/LoginPage.tsx
// Login and registration form.
// On success: saves tokens to localStorage and redirects to /app.

import { useState }  from "react"
import { useNavigate } from "react-router-dom"
import { login, register } from "../utils/api"
import { saveTokens }      from "../utils/auth"

export default function LoginPage() {
  const navigate = useNavigate()

  const [mode,      setMode]      = useState<"login" | "register">("login")
  const [email,     setEmail]     = useState("")
  const [password,  setPassword]  = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const handleSubmit = async (): Promise<void> => {
    setError(null)

    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.")
      return
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }

    setIsLoading(true)

    try {
      const result = mode === "login"
        ? await login(email, password)
        : await register(email, password)

      saveTokens(result.tokens.accessToken, result.tokens.refreshToken)
      navigate("/app")

    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-linear-to-br from-blue-50 to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🤖</div>
          <h1 className="text-2xl font-bold text-slate-800">ResearchBot</h1>
          <p className="text-slate-500 text-sm mt-1">
            RAG-powered document intelligence
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-6">

          {/* Mode toggle */}
          <div className="flex gap-1 mb-6 bg-slate-100 p-1 rounded-xl">
            <button
              onClick={() => { setMode("login"); setError(null) }}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                mode === "login"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => { setMode("register"); setError(null) }}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                mode === "register"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Register
            </button>
          </div>

          {/* Fields */}
          <div className="space-y-4 mb-5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void handleSubmit() }}
                placeholder="you @example.com"
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void handleSubmit() }}
                placeholder="Minimum 8 characters"
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Submit */}
          <button
            onClick={() => void handleSubmit()}
            disabled={isLoading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-semibold rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {mode === "login" ? "Signing in..." : "Creating account..."}
              </>
            ) : (
              mode === "login" ? "Sign In" : "Create Account"
            )}
          </button>
        </div>

        <p className="text-center text-xs text-slate-400 mt-4">
          Built with React + TypeScript + pgvector + Gemini
        </p>
      </div>
    </div>
  )
}
