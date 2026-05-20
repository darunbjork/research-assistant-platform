import jwt from "jsonwebtoken"
import type { JwtPayload, AuthTokens } from "../types"
import { UnauthorizedError } from "../middleware/error.middleware"

// ── Token Configuration ───────────────────────────────────────────────────
// These durations control the security/convenience tradeoff.
// In production: access=15m, refresh=7d
// In development: access=1h (less annoying to work with)
const ACCESS_TOKEN_EXPIRY = process.env.NODE_ENV === "production" ? "15m" : "1h"
const REFRESH_TOKEN_EXPIRY = "7d"

export function signTokens(payload: Omit<JwtPayload, "iat" | "exp">): AuthTokens {
  const accessSecret = process.env.JWT_SECRET
  const refreshSecret = process.env.JWT_REFRESH_SECRET

  if (!accessSecret || !refreshSecret) {
    throw new Error(
      "JWT_SECRET and JWT_REFRESH_SECRET must be set in .env. " +
        "Minimum 32 characters each. They must be different strings."
    )
  }

  const accessToken = jwt.sign(payload, accessSecret, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  })

  const refreshToken = jwt.sign(payload, refreshSecret, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  })

  return { accessToken, refreshToken }
}

export function verifyAccessToken(token: string): JwtPayload {
  const secret = process.env.JWT_SECRET

  if (!secret) {
    throw new Error("JWT_SECRET not configured")
  }

  try {
    return jwt.verify(token, secret) as JwtPayload
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
  const secret = process.env.JWT_REFRESH_SECRET

  if (!secret) {
    throw new Error("JWT_REFRESH_SECRET not configured")
  }

  try {
    return jwt.verify(token, secret) as JwtPayload
  } catch (error: unknown) {
    const err = error as jwt.JsonWebTokenError
    if (err.name === "TokenExpiredError") {
      throw new UnauthorizedError("Refresh token expired — please log in again")
    }
    throw new UnauthorizedError("Invalid refresh token")
  }
}
