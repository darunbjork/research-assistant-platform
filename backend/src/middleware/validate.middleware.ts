// * Validates request bodies before they reach controllers.
// Without validation, a missing email field causes a crash deep inside the service.
// With validation, it returns a clean 400 error immediately.
//
// ! WHY NOT USE ZOD OR JOI?
// Those are excellent libraries. We are keeping dependencies minimal for now.
// You will see the same pattern — check shape, return error or call next().

import type { Request, Response, NextFunction } from "express"
import { ValidationError } from "./error.middleware"
import type { RegisterRequest, LoginRequest } from "../types"

export function validateRegister(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Partial<RegisterRequest>

  if (!body.email || typeof body.email !== "string") {
    next(new ValidationError("email is required and must be a string"))
    return
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(body.email)) {
    next(new ValidationError("email must be a valid email address"))
    return
  }

  if (!body.password || typeof body.password !== "string") {
    next(new ValidationError("password is required and must be a string"))
    return
  }

  if (body.password.length < 8) {
    next(new ValidationError("password must be at least 8 characters"))
    return
  }

  next()
}

export function validateLogin(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Partial<LoginRequest>

  if (!body.email || typeof body.email !== "string") {
    next(new ValidationError("email is required"))
    return
  }

  if (!body.password || typeof body.password !== "string") {
    next(new ValidationError("password is required"))
    return
  }

  next()
}
