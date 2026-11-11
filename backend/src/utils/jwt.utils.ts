import jwt from "jsonwebtoken"
import type { JwtPayload, AuthTokens } from "../types"
import { UnauthorizedError } from "../middleware/error.middleware"
import { env } from "../config/env"

// ── Token Configuration ───────────────────────────────────────────────────
// These durations control the security/convenience tradeoff.
// In production: access=15m, refresh=7d
// In development: access=1h (less annoying to work with)
const ACCESS_TOKEN_EXPIRY = env.NODE_ENV === "production" ? "15m" : "1h"
const REFRESH_TOKEN_EXPIRY = "7d"

export function signTokens(payload: Omit<JwtPayload, "iat" | "exp">): AuthTokens {
  // env.ts guarantees both secrets exist (required, min 32 chars, different).
  const accessToken = jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  })

  const refreshToken = jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  })

  return { accessToken, refreshToken }
}

export function verifyAccessToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as JwtPayload
  } catch (error: unknown) {
    const err = error as jwt.JsonWebTokenError
    if (err.name === "TokenExpiredError") {
      throw new UnauthorizedError("Access token expired — please refresh")
    }
    if (err.name === "JsonWebTokenError") {
      throw new UnauthorizedError("Invalid access token")
    }
    throw new UnauthorizedError("Token verification failed")
  }
}

export function verifyRefreshToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload
  } catch (error: unknown) {
    const err = error as jwt.JsonWebTokenError
    if (err.name === "TokenExpiredError") {
      throw new UnauthorizedError("Refresh token expired — please log in again")
    }
    throw new UnauthorizedError("Invalid refresh token")
  }
}
