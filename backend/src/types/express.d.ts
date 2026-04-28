declare global {
  namespace Express {
    interface User {
      role: "GUEST" | "USER" | "ADMIN"
      userId?: string
    }

    interface Request {
      user?: User
    }
  }
}
