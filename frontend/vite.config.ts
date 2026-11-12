import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev is same-origin: forward API calls to the backend (port 3001).
      '/api': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      // WebSocket upgrade for the agent chat (/ws/agent).
      '/ws': { target: 'ws://localhost:3001', ws: true }
    }
  }
})
