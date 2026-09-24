import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import type { RegisterRequest, LoginRequest, AuthResponse, PublicUser } from "../types"
import { signTokens, verifyRefreshToken } from "../utils/jwt.utils"
import { ValidationError, UnauthorizedError, NotFoundError } from "../middleware/error.middleware"
import { logRagEvent, logError } from "../utils/logger"
import { logger } from "../utils/logger" // Import logger for debug messages

// BCRYPT_ROUNDS: 12 = ~250ms per hash on modern hardware.
// This is intentionally slow — makes brute-forcing passwords expensive.
// ! Never go below 10. 14+ is for very high-security systems (slower UX).
const BCRYPT_ROUNDS = 12

export class AuthService {
  constructor(private readonly prisma: PrismaClient) {}

  async register(data: RegisterRequest): Promise<AuthResponse> {
    const start = Date.now()

    logger.debug("Starting registration process", { service: "AuthService", email: data.email })

    const existing = await this.prisma.user.findUnique({
      where: { email: data.email.toLowerCase() },
    })

    logger.debug("Checked for existing user", {
      service: "AuthService",
      email: data.email,
      exists: existing !== null,
    })

    if (existing !== null) {
      throw new ValidationError("An account with this email already exists")
    }

    let passwordHash: string
    try {
      passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS)
      logger.debug("Password hashed successfully", { service: "AuthService", email: data.email })
    } catch (error: unknown) {
      logError("Password hashing failed", error as Error, {
        service: "AuthService",
        email: data.email,
      })
      throw error
    }

    let user: { id: string; email: string; role: "GUEST" | "USER" | "ADMIN"; createdAt: Date }
    try {
      user = await this.prisma.user.create({
        data: {
          email: data.email.toLowerCase(),
          passwordHash,
          role: "USER",
        },
      })
      logger.debug("User created in database", {
        service: "AuthService",
        userId: user.id,
        email: user.email,
      })
    } catch (error: unknown) {
      logError("Database user creation failed", error as Error, {
        service: "AuthService",
        email: data.email,
      })
      throw error
    }

    let tokens: { accessToken: string; refreshToken: string }
    try {
      tokens = signTokens({
        userId: user.id,
        email: user.email,
        role: user.role,
      })
      logger.debug("JWT tokens signed successfully", { service: "AuthService", userId: user.id })
    } catch (error: unknown) {
      logError("JWT token signing failed", error as Error, {
        service: "AuthService",
        userId: user.id,
      })
      throw error
    }

    logRagEvent("ingest", "User registered", {
      service: "AuthService",
      userId: user.id,
      durationMs: Date.now() - start,
    })

    return {
      tokens,
      user: this.toPublicUser(user),
    }
  }

  async login(data: LoginRequest): Promise<AuthResponse> {
    const start = Date.now()

    const user = await this.prisma.user.findUnique({
      where: { email: data.email.toLowerCase() },
    })

    if (user === null) {
      throw new UnauthorizedError("Invalid email or password")
    }

    const passwordValid = await bcrypt.compare(data.password, user.passwordHash)

    if (!passwordValid) {
      logError("Failed login attempt", new Error("Invalid password"), {
        service: "AuthService",
        userId: user.id,
      })
      throw new UnauthorizedError("Invalid email or password")
    }

    const tokens = signTokens({
      userId: user.id,
      email: user.email,
      role: user.role,
    })

    logRagEvent("ingest", "User logged in", {
      service: "AuthService",
      userId: user.id,
      durationMs: Date.now() - start,
    })

    return {
      tokens,
      user: this.toPublicUser(user),
    }
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const payload = verifyRefreshToken(refreshToken)

    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
    })

    if (user === null) {
      throw new NotFoundError("User")
    }

    const tokens = signTokens({
      userId: user.id,
      email: user.email,
      role: user.role,
    })

    logRagEvent("ingest", "Tokens refreshed", {
      service: "AuthService",
      userId: user.id,
    })

    return {
      tokens,
      user: this.toPublicUser(user),
    }
  }

  async getMe(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    })

    if (user === null) {
      throw new NotFoundError("User")
    }

    return this.toPublicUser(user)
  }

  private toPublicUser(user: {
    id: string
    email: string
    role: "GUEST" | "USER" | "ADMIN"
    createdAt: Date
  }): PublicUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    }
  }
}
