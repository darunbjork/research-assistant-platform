// TODO: These are the shapes that flow through register → login → middleware → controllers.

// * What we store inside the JWT token.
// ! IMPORTANT: Never put sensitive data in a JWT — it is base64 encoded, not encrypted.
// ! Anyone can decode a JWT and read its payload. Only the SIGNATURE is secret.
export interface JwtPayload {
  userId: string
  email: string
  role: "GUEST" | "USER" | "ADMIN"
  iat?: number  
  exp?: number
}

export interface AuthTokens {
  accessToken: string    
  refreshToken: string 
}

export interface AuthResponse {
  tokens: AuthTokens
  user: PublicUser
}

export interface PublicUser {
  id: string
  email: string
  role: "GUEST" | "USER" | "ADMIN"
  createdAt: Date
}

export interface RegisterRequest {
  email: string
  password: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface RefreshRequest {
  refreshToken: string
}