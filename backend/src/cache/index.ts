// backend/src/cache/index.ts
// Singleton cache instances.

import { redis } from "../utils/redis"
import { SearchCache } from "./search.cache"

// One shared SearchCache instance — created once, used everywhere
export const searchCache = new SearchCache(redis)

export { SearchCache } from "./search.cache"
