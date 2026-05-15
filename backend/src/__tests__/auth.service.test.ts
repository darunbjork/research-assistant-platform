import { AuthService } from "../services/auth.service"
import { makeMockPrismaClient } from "./helpers/mock-factories"

// ── Mock bcryptjs ─────────────────────────────────────────────────────────
jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("$2b$12$hashedpassword"),
  compare: jest.fn().mockResolvedValue(true),
}))

// ── Mock jwt ──────────────────────────────────────────────────────────────
jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock.jwt.token"),
  verify: jest.fn().mockReturnValue({
    userId: "user-mock-001",
    email: "test@example.com",
    role: "USER",
  }),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────
const VALID_REGISTER = { email: "new@example.com", password: "securepass123" }
const VALID_LOGIN = { email: "test@example.com", password: "securepass123" }

describe("AuthService", () => {
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

  // ── register() ────────────────────────────────────────────────────────
  describe("register()", () => {
    beforeEach(() => {
      p.user.findUnique.mockResolvedValue(null)
    })

    it("returns AuthResponse with tokens and user", async () => {
      // Return the email actually passed to create
      p.user.create.mockImplementation(
        (args: { data: { email: string; passwordHash: string; role: string } }) =>
          Promise.resolve({
            id: "user-mock-001",
            email: args.data.email,
            role: "USER",
            createdAt: new Date(),
          })
      )

      const result = await service.register(VALID_REGISTER)

      expect(result.tokens.accessToken).toBeDefined()
      expect(result.tokens.refreshToken).toBeDefined()
      expect(result.user.email).toBe("new@example.com")
    })

    it("creates user with lowercase email", async () => {
      await service.register({ email: "UPPER@EXAMPLE.COM", password: "securepass123" })

      expect(p.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: "upper@example.com",
          }),
        })
      )
    })

    it("stores passwordHash not plain password", async () => {
      await service.register(VALID_REGISTER)

      expect(p.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ passwordHash: "$2b$12$hashedpassword" }),
        })
      )

      const callArg = p.user.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
      expect(callArg?.data?.["password"]).toBeUndefined()
    })

    it("throws ValidationError when email already exists", async () => {
      p.user.findUnique.mockResolvedValue({
        id: "existing-user",
        email: "new@example.com",
        passwordHash: "$2b$12$hash",
        role: "USER",
        createdAt: new Date(),
      })

      await expect(service.register(VALID_REGISTER)).rejects.toThrow("already exists")
    })

    it("does not create user when email is taken", async () => {
      p.user.findUnique.mockResolvedValue({ id: "existing" } as never)
      await expect(service.register(VALID_REGISTER)).rejects.toThrow()
      expect(p.user.create).not.toHaveBeenCalled()
    })

    it("response does not include passwordHash", async () => {
      const result = await service.register(VALID_REGISTER)
      const userJson = JSON.stringify(result.user)
      expect(userJson).not.toContain("passwordHash")
      expect(userJson).not.toContain("$2b$12$")
    })
  })

  // ── login() ───────────────────────────────────────────────────────────
  describe("login()", () => {
    const mockUser = {
      id: "user-mock-001",
      email: "test@example.com",
      passwordHash: "$2b$12$hashedpassword",
      role: "USER" as const,
      createdAt: new Date(),
    }

    beforeEach(() => {
      p.user.findUnique.mockResolvedValue(mockUser)
    })

    it("returns AuthResponse on valid credentials", async () => {
      const result = await service.login(VALID_LOGIN)
      expect(result.tokens.accessToken).toBeDefined()
      expect(result.user.email).toBe("test@example.com")
    })

    it("throws UnauthorizedError when user not found", async () => {
      p.user.findUnique.mockResolvedValue(null)
      await expect(service.login(VALID_LOGIN)).rejects.toThrow("Invalid email or password")
    })

    it("throws UnauthorizedError when password is wrong", async () => {
      const bcrypt = require("bcryptjs") as { compare: jest.Mock }
      bcrypt.compare.mockResolvedValueOnce(false)
      await expect(service.login(VALID_LOGIN)).rejects.toThrow("Invalid email or password")
    })

    it("uses the same error message for wrong email AND wrong password", async () => {
      p.user.findUnique.mockResolvedValueOnce(null)
      let error1: Error | null = null
      try {
        await service.login(VALID_LOGIN)
      } catch (e) {
        error1 = e as Error
      }

      p.user.findUnique.mockResolvedValueOnce(mockUser)
      const bcrypt = require("bcryptjs") as { compare: jest.Mock }
      bcrypt.compare.mockResolvedValueOnce(false)
      let error2: Error | null = null
      try {
        await service.login(VALID_LOGIN)
      } catch (e) {
        error2 = e as Error
      }

      expect(error1?.message).toBe(error2?.message)
    })

    it("normalises email to lowercase before lookup", async () => {
      await service.login({ email: "TEST@EXAMPLE.COM", password: "securepass123" })
      expect(p.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ email: "test@example.com" }) })
      )
    })
  })

  // ── getMe() ───────────────────────────────────────────────────────────
  describe("getMe()", () => {
    it("returns user data for valid userId", async () => {
      p.user.findUnique.mockResolvedValue({
        id: "user-1",
        email: "user@example.com",
        role: "USER",
        createdAt: new Date(),
      } as never)

      const result = await service.getMe("user-1")
      expect(result.email).toBe("user@example.com")
    })

    it("throws NotFoundError for non-existent userId", async () => {
      p.user.findUnique.mockResolvedValue(null)
      await expect(service.getMe("non-existent-id")).rejects.toThrow("not found")
    })

    it("does not return passwordHash", async () => {
      p.user.findUnique.mockResolvedValue({
        id: "user-1",
        email: "user@example.com",
        passwordHash: "$2b$12$secret",
        role: "USER",
        createdAt: new Date(),
      } as never)

      const result = await service.getMe("user-1")
      expect(JSON.stringify(result)).not.toContain("passwordHash")
    })
  })
})
