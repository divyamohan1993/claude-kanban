#!/bin/bash
cd "$(dirname "$0")"

PID_FILE=".server.pid"

echo ""
echo "  Claude Kanban - Stop"
echo ""

if [ ! -f "$PID_FILE" ]; then
  printf "  [FAIL] No server running (no PID file)\n\n"
  exit 1
fi

PID=$(cat "$PID_FILE" 2>/dev/null)
if [ -z "$PID" ]; then
  rm -f "$PID_FILE"
  printf "  [FAIL] Invalid PID file\n\n"
  exit 1
fi

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null
  # Wait for clean shutdown (up to 5s)
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 0.5
  done
  # Force kill if still alive
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  printf "  [OK]   Server stopped (PID %s)\n\n" "$PID"
else
  rm -f "$PID_FILE"
  printf "  [OK]   Server was not running (stale PID file cleaned up)\n\n"
fi
