// frontend/src/utils/auth.ts
// Auth state management utilities.
// Stores tokens in localStorage and provides typed accessors.

export function saveTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem("accessToken",  accessToken)
  localStorage.setItem("refreshToken", refreshToken)
}

export function clearTokens(): void {
  localStorage.removeItem("accessToken")
  localStorage.removeItem("refreshToken")
}

export function getAccessToken(): string | null {
  return localStorage.getItem("accessToken")
}

export function isLoggedIn(): boolean {
  return localStorage.getItem("accessToken") !== null
}
