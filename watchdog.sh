#!/bin/bash
# ============================================================================
# Claude Kanban Watchdog — monitors server heartbeat, auto-restarts on crash.
# Run this in a separate terminal, tmux, or as a systemd service.
#
# How it works:
#   1. Checks .data/.heartbeat every 60 seconds
#   2. If heartbeat file is stale (>90 seconds old), server is dead
#   3. Kills orphaned node processes and restarts the server
#   4. On restart, recoverOrphanedCards() resets stuck cards
#   5. Recovery poller auto-resumes rate-limited cards when usage resets
#
# Usage:
#   ./watchdog.sh                 (run in foreground)
#   nohup ./watchdog.sh &         (run in background)
# ============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HEARTBEAT="$ROOT/.data/.heartbeat"
RESTART_MARKER="$ROOT/.data/.restart-requested"
WATCHDOG_LOG="$ROOT/.data/watchdog.log"
CHECK_INTERVAL=60
STALE_THRESHOLD=90

mkdir -p "$ROOT/.data"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg"
  echo "$msg" >> "$WATCHDOG_LOG"
}

start_server() {
  log "Starting server..."

  # Kill any orphaned node processes running our server
  pkill -f "node.*src/server.js" 2>/dev/null || true
  sleep 2

  # Start server in background
  cd "$ROOT"
  nohup node src/server.js >> .data/server.log 2>&1 &
  local pid=$!
  log "Server started (PID $pid)"

  # Wait for server to initialize
  sleep 10
}

log "Watchdog started for $ROOT"

while true; do
  # Check if heartbeat file exists
  if [ ! -f "$HEARTBEAT" ]; then
    log "No heartbeat file — server may not be running"
    start_server
    continue
  fi

  # Check heartbeat file age
  if [ "$(uname)" = "Darwin" ]; then
    # macOS
    file_time=$(stat -f %m "$HEARTBEAT")
  else
    # Linux
    file_time=$(stat -c %Y "$HEARTBEAT")
  fi
  now=$(date +%s)
  age=$((now - file_time))

  if [ "$age" -gt "$STALE_THRESHOLD" ]; then
    log "STALE heartbeat (${age}s old) — server crashed or hung"
    start_server
  else
    # Check for restart marker
    if [ -f "$RESTART_MARKER" ]; then
      log "Restart requested by server — restarting"
      rm -f "$RESTART_MARKER"
      start_server
    fi
  fi

  sleep "$CHECK_INTERVAL"
done
