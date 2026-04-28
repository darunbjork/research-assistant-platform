// * Wires HTTP paths to controller methods, with validation middleware in between.
//
// TODO: REQUEST FLOW for POST /api/v1/auth/register:
// 1. requestLoggerMiddleware (logs the request)
// 2. validateRegister        (checks body shape — returns 400 if invalid)
// 3. controller.register     (calls AuthService, returns tokens)
// 4. errorMiddleware         (catches any thrown errors)

// * Auth routes with full Swagger JSDoc documentation.
// * swagger-jsdoc reads the @swagger comments and generates the OpenAPI spec.

import { Router } from "express"
import { AuthController } from "../controllers/auth.controller"
import { authMiddleware } from "../middleware/auth.middleware"
import { validateRegister, validateLogin } from "../middleware/validate.middleware"

const router = Router()
const controller = new AuthController()

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
router.post("/register", validateRegister, controller.register)

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
router.post("/login", validateLogin, controller.login)

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
