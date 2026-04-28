// Tests the ApiResult helper functions from src/types/api.types.ts
// No HTTP server needed — pure unit tests.

import { ok, fail } from "../types/api.types"

describe("ApiResult helpers", () => {
  describe("ok()", () => {
    it("returns success: true with the provided data", () => {
      const result = ok({ message: "hello" })

      expect(result.success).toBe(true)
      expect(result.data).toEqual({ message: "hello" })
      expect(result.error).toBeNull()
    })

    it("includes meta when provided", () => {
      const result = ok("data", { page: 1, total: 100 })

      expect(result.meta?.page).toBe(1)
      expect(result.meta?.total).toBe(100)
    })

    it("works with null data", () => {
      const result = ok(null)
      expect(result.success).toBe(true)
      expect(result.data).toBeNull()
    })

    it("works with array data", () => {
      const result = ok([1, 2, 3])
      expect(result.data).toEqual([1, 2, 3])
    })
  })

  describe("fail()", () => {
    it("returns success: false with the error message", () => {
      const result = fail("Something went wrong")

      expect(result.success).toBe(false)
      expect(result.data).toBeNull()
      expect(result.error).toBe("Something went wrong")
    })

    it("data is always null on failure", () => {
      const result = fail<string[]>("error")
      expect(result.data).toBeNull()
    })
  })
})
