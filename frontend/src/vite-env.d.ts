/// <reference types="vite/client" />

// Vite-exposed environment variables. Both URLs are optional — when unset
// the app uses same-origin defaults (dev: Vite proxy; prod: Caddy).
interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_WS_URL?: string
}
