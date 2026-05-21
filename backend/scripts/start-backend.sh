#!/bin/bash
PORT=3002
PID=$(lsof -ti:$PORT)
if [ -n "$PID" ]; then
  echo "Killing process on port $PORT: $PID"
  kill -9 $PID
fi
cd backend && npm run dev
