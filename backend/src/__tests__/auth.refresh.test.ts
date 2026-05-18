import { AuthService } from "../services/auth.service"
import { makeMockPrismaClient } from "./helpers/mock-factories"

// ── Mock jwt ──────────────────────────────────────────────────────────────
jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock.jwt.token"),
  verify: jest.fn().mockImplementation((token: string) => {
    if (token === "expired-token") throw { name: "TokenExpiredError" }
    if (token === "invalid-token") throw { name: "JsonWebTokenError" }
    return {
      userId: "user-mock-001",
      email: "test@example.com",
      role: "USER",
    }
  }),
}))

describe("AuthService Refresh", () => {
  let service: AuthService
  let mockPrisma: ReturnType<typeof makeMockPrismaClient>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any

  beforeEach(() => {
    mockPrisma = makeMockPrismaClient()
    p = mockPrisma
    service = new AuthService(mockPrisma)

    process.env.JWT_SECRET = "test-secret-32-chars-minimum-abc"
    process.env.JWT_REFRESH_SECRET = "refresh-secret-32-chars-minimum-xyz"
  })

  // ── refresh() ────────────────────────────────────────────────────────
  describe("refresh()", () => {
    it("returns AuthResponse with new tokens for valid refresh token", async () => {
      p.user.findUnique.mockResolvedValue({
        id: "user-mock-001",
        email: "test@example.com",
        role: "USER",
      })

      const result = await service.refresh("valid-refresh-token")

      expect(result.tokens.accessToken).toBe("mock.jwt.token")
      expect(result.tokens.refreshToken).toBe("mock.jwt.token")
    })

    it("throws UnauthorizedError for expired refresh token", async () => {
      await expect(service.refresh("expired-token")).rejects.toThrow("Refresh token expired")
    })

    it("throws UnauthorizedError for invalid refresh token", async () => {
      await expect(service.refresh("invalid-token")).rejects.toThrow("Invalid refresh token")
    })
  })
})
