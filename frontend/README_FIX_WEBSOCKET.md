# Fix for WebSocket Connection Issue

The WebSocket connection was failing to connect to the backend server. The issue was traced to the incorrect URL endpoint in `src/hooks/useAgentWebSocket.ts`.

## Changes
- Updated the WebSocket URL in `src/hooks/useAgentWebSocket.ts` to connect to `WS_URL` directly instead of appending `/ws/agent`.

This change assumes the backend WebSocket server is listening on the root path (e.g., `ws://localhost:3002`).
