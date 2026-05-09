// frontend/src/App.tsx
// Updated Day 14: adds /demo route for the comparison component.

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import LoginPage         from "./pages/LoginPage"
import AppPage           from "./pages/AppPage"
import AgentComparison   from "./components/AgentComparison"
import { isLoggedIn }    from "./utils/auth"

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!isLoggedIn()) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route
          path="/app"
          element={
            <ProtectedRoute>
              <AppPage />
            </ProtectedRoute>
          }
        />

        {/* Demo / portfolio route — agent vs RAG comparison */}
        <Route
          path="/demo"
          element={
            <ProtectedRoute>
              <div className="min-h-screen py-8 bg-slate-50">
                <AgentComparison />
              </div>
            </ProtectedRoute>
          }
        />

        <Route
          path="*"
          element={<Navigate to={isLoggedIn() ? "/app" : "/login"} replace />}
        />
      </Routes>
    </BrowserRouter>
  )
}