// backend/src/__tests__/jwt.utils.test.ts
// Tests for JWT utility functions.

// We test with real JWT operations (no external API dependency)
// JWT sign/verify is pure cryptographic computation.

describe("JWT utilities", () => {
  let signTokens: typeof import("../utils/jwt.utils").signTokens
  let verifyAccessToken: typeof import("../utils/jwt.utils").verifyAccessToken
  let verifyRefreshToken: typeof import("../utils/jwt.utils").verifyRefreshToken

  beforeAll(async () => {
    // Set env vars before importing (they're read at module load)
    process.env.JWT_SECRET = "test-access-secret-32-chars-minimum-abc"
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret-32-chars-minimum-xyz"

    const mod = await import("../utils/jwt.utils")
    signTokens = mod.signTokens
    verifyAccessToken = mod.verifyAccessToken
    verifyRefreshToken = mod.verifyRefreshToken
  })

  const VALID_PAYLOAD = {
    userId: "user-123",
    email: "test@example.com",
    role: "USER" as const,
  }

  // ── signTokens() ───────────────────────────────────────────────────────
  describe("signTokens()", () => {
    it("returns an accessToken and refreshToken", () => {
      const tokens = signTokens(VALID_PAYLOAD)

      expect(typeof tokens.accessToken).toBe("string")
      expect(typeof tokens.refreshToken).toBe("string")
      expect(tokens.accessToken.length).toBeGreaterThan(0)
      expect(tokens.refreshToken.length).toBeGreaterThan(0)
    })

    it("produces different tokens for different payloads", () => {
      const tokens1 = signTokens({ userId: "user-1", email: "a@b.com", role: "USER" })
      const tokens2 = signTokens({ userId: "user-2", email: "c@d.com", role: "USER" })

      expect(tokens1.accessToken).not.toBe(tokens2.accessToken)
    })

    it("access and refresh tokens are different strings", () => {
      const tokens = signTokens(VALID_PAYLOAD)
      expect(tokens.accessToken).not.toBe(tokens.refreshToken)
    })

    it("access token is a valid JWT format (3 dot-separated parts)", () => {
      const tokens = signTokens(VALID_PAYLOAD)
      const parts = tokens.accessToken.split(".")
      expect(parts).toHaveLength(3)
    })

    it("throws when JWT_SECRET is not set", () => {
      const savedSecret = process.env.JWT_SECRET
      delete process.env.JWT_SECRET

      expect(() => signTokens(VALID_PAYLOAD)).toThrow()

      process.env.JWT_SECRET = savedSecret
    })
  })

  // ── verifyAccessToken() ────────────────────────────────────────────────
  describe("verifyAccessToken()", () => {
    it("returns the payload for a valid access token", () => {
      const tokens = signTokens(VALID_PAYLOAD)
      const payload = verifyAccessToken(tokens.accessToken)

      expect(payload.userId).toBe("user-123")
      expect(payload.email).toBe("test@example.com")
      expect(payload.role).toBe("USER")
    })

    it("throws UnauthorizedError for invalid token string", () => {
      expect(() => verifyAccessToken("not.a.valid.token")).toThrow()
    })

    it("throws UnauthorizedError for expired token", () => {
      // Sign a token that expired 1 second ago
      const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken")
      const expiredToken = jwt.sign(
        VALID_PAYLOAD,
        process.env.JWT_SECRET ?? "secret",
        { expiresIn: -1 } // already expired
      )

      expect(() => verifyAccessToken(expiredToken)).toThrow()
    })

    it("throws UnauthorizedError for token signed with wrong secret", () => {
      const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken")
      const wrongToken = jwt.sign(VALID_PAYLOAD, "completely-wrong-secret")

      expect(() => verifyAccessToken(wrongToken)).toThrow()
    })

    it("throws for refresh token used as access token", () => {
      // Access and refresh use different secrets — cross-use should fail
      const tokens = signTokens(VALID_PAYLOAD)

      // Using refresh token where access token is expected should throw
      // (because they're signed with different secrets)
      expect(() => verifyAccessToken(tokens.refreshToken)).toThrow()
    })
  })

  // ── verifyRefreshToken() ──────────────────────────────────────────────
  describe("verifyRefreshToken()", () => {
    it("returns payload for valid refresh token", () => {
      const tokens = signTokens(VALID_PAYLOAD)
      const payload = verifyRefreshToken(tokens.refreshToken)

      expect(payload.userId).toBe("user-123")
    })

    it("throws for invalid refresh token", () => {
      expect(() => verifyRefreshToken("invalid.token.here")).toThrow()
    })

    it("throws for access token used as refresh token", () => {
      const tokens = signTokens(VALID_PAYLOAD)
      expect(() => verifyRefreshToken(tokens.accessToken)).toThrow()
    })
  })
})
