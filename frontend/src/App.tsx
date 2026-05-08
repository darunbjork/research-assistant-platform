// frontend/src/App.tsx
// Root component — sets up React Router with two routes:
//   /login → LoginPage
//   /app   → AppPage (requires auth — redirects to /login if no token)

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import LoginPage from "./pages/LoginPage"
import AppPage   from "./pages/AppPage"
import { isLoggedIn } from "./utils/auth"

// ── Protected Route wrapper ────────────────────────────────────────────────
// Redirects to /login if the user is not authenticated.
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
        {/* Public route */}
        <Route path="/login" element={<LoginPage />} />

        {/* Protected route */}
        <Route
          path="/app"
          element={
            <ProtectedRoute>
              <AppPage />
            </ProtectedRoute>
          }
        />

        {/* Default redirect */}
        <Route
          path="*"
          element={
            <Navigate to={isLoggedIn() ? "/app" : "/login"} replace />
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
