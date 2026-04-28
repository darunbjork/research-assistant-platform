// * Wires HTTP paths to controller methods, with validation middleware in between.
//
// TODO: REQUEST FLOW for POST /api/v1/auth/register:
// 1. requestLoggerMiddleware (logs the request)
// 2. validateRegister        (checks body shape — returns 400 if invalid)
// 3. controller.register     (calls AuthService, returns tokens)
// 4. errorMiddleware         (catches any thrown errors)

import { Router } from "express"
import { AuthController } from "../controllers/auth.controller"
import { authMiddleware } from "../middleware/auth.middleware"
import { validateRegister, validateLogin } from "../middleware/validate.middleware"

const router = Router()
const controller = new AuthController()

// * Public routes — no token required
router.post("/register", validateRegister, controller.register)
router.post("/login",    validateLogin,    controller.login)
router.post("/refresh",                   controller.refresh)

// * Protected route — authMiddleware verifies token before controller runs
router.get("/me", authMiddleware, controller.me)

export default router