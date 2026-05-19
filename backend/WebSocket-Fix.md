# WebSocket Connection Failure Resolution

## Issue
The frontend application was frequently reporting the following error in the browser console during component initialization and unmounting:
`WebSocket is closed before the connection is established`

This error was triggered because the `useAgentWebSocket` hook was attempting to call `ws.close()` while the WebSocket was still in the `CONNECTING` (readyState 0) state, often due to rapid re-renders or unmounting behavior in React 18's Strict Mode. Additionally, the WebSocket connection URL was incorrectly constructed, causing the connection to fail on the backend.

## Solution

### 1. Fixed WebSocket URL Construction
The frontend hook was incorrectly connecting to `ws://localhost:3002/` instead of the required endpoint `ws://localhost:3002/ws/agent`.

**Correction:**
```typescript
// Previously
const ws = new WebSocket(`${WS_URL}`)

// Fixed
const ws = new WebSocket(`${WS_URL}/ws/agent`)
```

### 2. Implemented Safe WebSocket Cleanup
To prevent the "WebSocket is closed before the connection is established" error, the `disconnect` function was updated to ensure that `ws.close()` is only invoked when the connection is fully open.

**Correction:**
```typescript
// Previously
wsRef.current.close()

// Fixed
if (wsRef.current.readyState === WebSocket.OPEN) {
  wsRef.current.close()
}
```
This check ensures that we do not attempt to close the connection while it is still in the `CONNECTING` phase, preventing the runtime error.
