#!/bin/bash
set -e

cd "$(dirname "$0")"

DATA_DIR=".data"
PID_FILE="$DATA_DIR/server.pid"
LOG_FILE="$DATA_DIR/server.log"
PORT="${PORT:-51777}"

info()  { printf "  [OK]   %s\n" "$1"; }
step()  { printf "  [..]   %s\n" "$1"; }
fail()  { printf "  [FAIL] %s\n" "$1"; exit 1; }

echo ""
echo "  Claude Kanban - Start"
echo ""

mkdir -p "$DATA_DIR"

# --- Already running? ---
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    info "Already running (PID $OLD_PID) at http://localhost:$PORT"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# --- Node.js ---
if ! command -v node >/dev/null 2>&1; then
  step "Node.js not found - installing..."
  if [ "$(uname)" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node
    else
      step "Installing Homebrew first..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [ -f /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
      fi
      brew install node
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq nodejs npm build-essential
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs npm gcc-c++ make
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm nodejs npm base-devel
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y nodejs npm gcc-c++ make
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add --no-cache nodejs npm python3 make g++
  else
    fail "Cannot auto-install Node.js. Install manually: https://nodejs.org"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js installation failed. Install manually: https://nodejs.org"
fi
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js 18+ required (found $(node -v)). Update: https://nodejs.org"
fi
info "Node.js $(node -v)"

# --- pnpm ---
if ! command -v pnpm >/dev/null 2>&1; then
  step "Installing pnpm..."
  npm install -g pnpm 2>/dev/null
fi
info "pnpm $(pnpm -v)"

# --- Claude CLI ---
if command -v claude >/dev/null 2>&1; then
  info "Claude CLI found"
else
  printf "  [WARN] Claude CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code\n"
  printf "         The board will run but cannot start AI sessions.\n"
fi

# --- Dependencies ---
step "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
info "Dependencies ready"

# --- Start server ---
step "Starting server..."
nohup node server.js > "$LOG_FILE" 2>&1 &
disown

# Wait for PID file (server writes it on listen)
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [ -f "$PID_FILE" ]; then break; fi
  sleep 0.5
done

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  echo ""
  info "Running at http://localhost:$PORT (PID $PID)"
  info "Logs: $LOG_FILE"
  echo ""
else
  echo ""
  printf "  [WARN] Server may have failed to start. Check %s\n" "$LOG_FILE"
  echo ""
  exit 1
fi
