import { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import { AuthController } from "../controllers/auth.controller"
import { authMiddleware } from "../middleware/auth.middleware"
import { validateRegister, validateLogin } from "../middleware/validate.middleware"
import {
  createIpRateLimiter,
  LOGIN_LIMIT,
  REGISTER_LIMIT,
} from "../middleware/rate-limit.middleware"

const router = Router()
const controller = new AuthController()

// ALLOW_REGISTRATION (default true): set to "false" to close signups with a
// 403. Read per-request so ops can flip it without a restart; task 3.1 moves
// env parsing into the Zod schema.
function requireRegistrationOpen(_req: Request, res: Response, next: NextFunction): void {
  const raw = (process.env.ALLOW_REGISTRATION ?? "true").trim().toLowerCase()
  if (raw === "false") {
    res.status(403).json({ error: "Registration is closed" })
    return
  }
  next()
}

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user account
 *     description: |
 *       Creates a new USER account and returns JWT tokens.
 *       The password is hashed with bcrypt (cost 12) before storage.
 *       Plain text password is never stored or logged.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 example: securepass123
 *     responses:
 *       201:
 *         description: Account created — returns tokens and public user data
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResult'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
router.post(
  "/register",
  createIpRateLimiter(REGISTER_LIMIT),
  requireRegistrationOpen,
  validateRegister,
  controller.register
)

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Log in to an existing account
 *     description: |
 *       Verifies credentials and returns fresh JWT tokens.
 *       Returns the same error message for wrong email OR wrong password
 *       to prevent user enumeration attacks.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 example: securepass123
 *     responses:
 *       200:
 *         description: Login successful — returns fresh tokens
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResult'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               data: null
 *               error: "Invalid email or password"
 */
router.post("/login", createIpRateLimiter(LOGIN_LIMIT), validateLogin, controller.login)

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Exchange a refresh token for new tokens
 *     description: |
 *       Used when the access token expires (after 15 min in production).
 *       Returns new access AND refresh tokens (rotation pattern).
 *       The old refresh token should be discarded after this call.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: The refreshToken received from /login or /register
 *     responses:
 *       200:
 *         description: New tokens issued
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResult'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/refresh", controller.refresh)

/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Get the currently authenticated user
 *     description: Returns the public profile of the user whose token is provided.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user profile
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResult'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/PublicUser'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/me", authMiddleware, controller.me)

export default router
