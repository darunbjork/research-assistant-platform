export function saveTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem("accessToken",  accessToken)
  localStorage.setItem("refreshToken", refreshToken)
}

export const setTokens = saveTokens

export function clearTokens(): void {
  localStorage.removeItem("accessToken")
  localStorage.removeItem("refreshToken")
}

export function getAccessToken(): string | null {
  return localStorage.getItem("accessToken")
}

export function getRefreshToken(): string | null {
  return localStorage.getItem("refreshToken")
}

export function isLoggedIn(): boolean {
  return localStorage.getItem("accessToken") !== null
}