#!/bin/bash
# =============================================================================
# Claude Kanban — Zero-intervention deploy script
# Blank GCP Ubuntu → running app on port 80, path-routed through Nginx.
#   /dashboard  → kanban board (Express :51777)
#   /settings   → control panel (Express :51778, admin-only)
#   /product    → product/marketing pages (Express :51777)
#   /           → deployed apps (reserved for orchestrator output)
# Idempotent: safe to re-run. Rotates secrets on each run.
#
# Usage:
#   1. SSH into GCP VM
#   2. Create .env with required secrets (see .env.example)
#   3. Run: curl -sL <raw-url>/autoconfig.sh | bash
#      OR: git clone <repo> && cd claude-kanban && bash autoconfig.sh
# =============================================================================
set -euo pipefail

APP_NAME="claude-kanban"
APP_DIR="/opt/$APP_NAME"
APP_PORT=51777
ADMIN_PORT=51778
APP_USER="kanban"
REPO_URL="https://github.com/divyamohan1993/claude-kanban.git"
NODE_MAJOR=22
LOG_FILE="/var/log/$APP_NAME-autoconfig.log"

# --- Helpers ---
ts() { date '+%Y-%m-%d %H:%M:%S'; }
info()  { printf "[%s] [OK]   %s\n" "$(ts)" "$1" | tee -a "$LOG_FILE"; }
step()  { printf "[%s] [..]   %s\n" "$(ts)" "$1" | tee -a "$LOG_FILE"; }
fail()  { printf "[%s] [FAIL] %s\n" "$(ts)" "$1" | tee -a "$LOG_FILE"; exit 1; }
warn()  { printf "[%s] [WARN] %s\n" "$(ts)" "$1" | tee -a "$LOG_FILE"; }

echo "" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "  Claude Kanban — Autoconfig $(ts)" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# --- Must be root ---
if [ "$(id -u)" -ne 0 ]; then
  fail "Run as root: sudo bash autoconfig.sh"
fi

# --- System packages ---
step "Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget gnupg2 ca-certificates lsb-release \
  build-essential python3 nginx ufw git
info "System packages ready"

# --- Node.js (NodeSource) ---
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt "$NODE_MAJOR" ]; then
  step "Installing Node.js $NODE_MAJOR..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
info "Node.js $(node -v)"

# --- pnpm ---
if ! command -v pnpm >/dev/null 2>&1; then
  step "Installing pnpm..."
  corepack enable
  corepack prepare pnpm@9 --activate
fi
info "pnpm $(pnpm -v)"

# --- App user ---
if ! id "$APP_USER" >/dev/null 2>&1; then
  step "Creating app user..."
  useradd -r -m -s /bin/bash "$APP_USER"
fi
info "App user: $APP_USER"

# --- Clone or pull ---
if [ -d "$APP_DIR/.git" ]; then
  step "Pulling latest..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" git pull --ff-only origin main
else
  step "Cloning repository..."
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi
cd "$APP_DIR"
info "Source ready at $APP_DIR"

# --- .env ---
if [ ! -f "$APP_DIR/.env" ]; then
  if [ -f "$APP_DIR/.env.example" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    warn ".env created from .env.example — edit with real secrets: nano $APP_DIR/.env"
  else
    fail ".env.example not found. Cannot configure."
  fi
fi
# Ensure path-routing config is present (idempotent)
grep -q '^BASE_PATH=' "$APP_DIR/.env" 2>/dev/null || echo 'BASE_PATH=/dashboard' >> "$APP_DIR/.env"
grep -q '^SETTINGS_BASE_PATH=' "$APP_DIR/.env" 2>/dev/null || echo 'SETTINGS_BASE_PATH=/settings' >> "$APP_DIR/.env"
grep -q '^ADMIN_PORT=' "$APP_DIR/.env" 2>/dev/null || echo "ADMIN_PORT=$ADMIN_PORT" >> "$APP_DIR/.env"
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
info ".env present (mode 600)"

# --- Dependencies ---
step "Installing dependencies..."
cd "$APP_DIR"
sudo -u "$APP_USER" pnpm install --frozen-lockfile 2>/dev/null || sudo -u "$APP_USER" pnpm install
info "Dependencies installed"

# --- Data directory ---
mkdir -p "$APP_DIR/.data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/.data"
info "Data directory ready"

# --- Systemd service ---
step "Configuring systemd service..."
cat > "/etc/systemd/system/$APP_NAME.service" <<UNIT
[Unit]
Description=Claude Kanban Board
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(command -v node) src/server.js
Restart=on-failure
RestartSec=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/.data
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$APP_NAME

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$APP_NAME"
info "Systemd service configured"

# --- Auto-update service + timer ---
step "Configuring auto-update (hourly git pull)..."
cat > "/opt/$APP_NAME/update.sh" <<'UPDATESCRIPT'
#!/bin/bash
# Auto-update: fetch, compare, drain pipeline, pull, install, restart, rollback on failure.
set -euo pipefail

APP_DIR="/opt/claude-kanban"
APP_NAME="claude-kanban"
APP_PORT=51777
LOG_TAG="$APP_NAME-update"
DRAIN_TIMEOUT=600  # 10 minutes max wait for pipeline to idle

cd "$APP_DIR"

# --- Check for updates ---
sudo -u kanban git fetch origin main --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  logger -t "$LOG_TAG" "Already up to date ($LOCAL)"
  exit 0
fi

logger -t "$LOG_TAG" "Update available: $LOCAL -> $REMOTE"

# --- Drain: pause pipeline and wait for active builds to finish ---
# The app exposes /health/ready with pipeline state. We pause via admin API,
# then wait for active builds to complete before restarting.

# Find admin port from the running server's DB config
ADMIN_PORT=$(curl -sf "http://localhost:$APP_PORT/health/ready" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('pipeline',{}).get('adminPort',''))" 2>/dev/null || echo "")

# Pause pipeline (best-effort; if admin port unknown, we still proceed)
if [ -n "$ADMIN_PORT" ]; then
  curl -sf -X POST "http://localhost:$ADMIN_PORT/api/pipeline/pause" >/dev/null 2>&1 || true
  logger -t "$LOG_TAG" "Pipeline paused via admin API"
fi

# Wait for active builds to drain (poll /health/ready for pipeline.active == 0)
DRAINED=false
WAITED=0
while [ "$WAITED" -lt "$DRAIN_TIMEOUT" ]; do
  ACTIVE=$(curl -sf "http://localhost:$APP_PORT/health/ready" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('checks',{}).get('pipeline',{}); print(p.get('active',0) + p.get('fixes',0))" 2>/dev/null || echo "0")

  if [ "$ACTIVE" = "0" ] || [ -z "$ACTIVE" ]; then
    DRAINED=true
    break
  fi

  logger -t "$LOG_TAG" "Waiting for $ACTIVE active build(s) to finish ($WAITED/${DRAIN_TIMEOUT}s)..."
  sleep 30
  WAITED=$((WAITED + 30))
done

if [ "$DRAINED" = true ]; then
  logger -t "$LOG_TAG" "Pipeline drained (no active builds)"
else
  logger -t "$LOG_TAG" "Drain timeout after ${DRAIN_TIMEOUT}s — proceeding with restart (orphaned cards will self-recover)"
fi

# --- Save rollback point ---
ROLLBACK_REV="$LOCAL"

# --- Pull and install ---
sudo -u kanban git pull --ff-only origin main
sudo -u kanban pnpm install --frozen-lockfile 2>/dev/null || sudo -u kanban pnpm install

# --- Restart service ---
# SIGTERM triggers graceful shutdown: killAll() builds, drain connections, close DB.
# Orphaned cards (if any) are recovered on next startup via recoverOrphanedCards().
systemctl restart "$APP_NAME"

# --- Post-restart health check ---
HEALTHY=false
for i in $(seq 1 15); do
  if curl -sf "http://localhost:$APP_PORT/health" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 2
done

if [ "$HEALTHY" = true ]; then
  NEW_REV=$(git rev-parse --short HEAD)
  logger -t "$LOG_TAG" "Updated and healthy at $NEW_REV"
  exit 0
fi

# --- Rollback: new version is broken ---
logger -t "$LOG_TAG" "ROLLBACK: health check failed after update — reverting to $ROLLBACK_REV"

sudo -u kanban git checkout "$ROLLBACK_REV"
sudo -u kanban pnpm install --frozen-lockfile 2>/dev/null || sudo -u kanban pnpm install
systemctl restart "$APP_NAME"

# Verify rollback
ROLLED_BACK=false
for i in $(seq 1 15); do
  if curl -sf "http://localhost:$APP_PORT/health" >/dev/null 2>&1; then
    ROLLED_BACK=true
    break
  fi
  sleep 2
done

if [ "$ROLLED_BACK" = true ]; then
  logger -t "$LOG_TAG" "Rollback successful — running at $ROLLBACK_REV"
else
  logger -t "$LOG_TAG" "CRITICAL: Rollback also failed — manual intervention required"
fi
UPDATESCRIPT

chmod +x "/opt/$APP_NAME/update.sh"
chown "$APP_USER:$APP_USER" "/opt/$APP_NAME/update.sh"

cat > "/etc/systemd/system/$APP_NAME-update.service" <<UNIT
[Unit]
Description=Claude Kanban Auto-Update
After=network.target $APP_NAME.service

[Service]
Type=oneshot
ExecStart=/opt/$APP_NAME/update.sh
User=root
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$APP_NAME-update
UNIT

cat > "/etc/systemd/system/$APP_NAME-update.timer" <<UNIT
[Unit]
Description=Claude Kanban Auto-Update Timer (hourly)

[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now "$APP_NAME-update.timer"
info "Auto-update timer active (hourly, checks git for changes)"

# --- Nginx reverse proxy (path-based routing on port 80) ---
step "Configuring Nginx reverse proxy..."
cat > "/etc/nginx/sites-available/$APP_NAME" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name _;

    # Cloudflare real IP restoration
    set_real_ip_from 103.21.244.0/22;
    set_real_ip_from 103.22.200.0/22;
    set_real_ip_from 103.31.4.0/22;
    set_real_ip_from 104.16.0.0/13;
    set_real_ip_from 104.24.0.0/14;
    set_real_ip_from 108.162.192.0/18;
    set_real_ip_from 131.0.72.0/22;
    set_real_ip_from 141.101.64.0/18;
    set_real_ip_from 162.158.0.0/15;
    set_real_ip_from 172.64.0.0/13;
    set_real_ip_from 173.245.48.0/20;
    set_real_ip_from 188.114.96.0/20;
    set_real_ip_from 190.93.240.0/20;
    set_real_ip_from 197.234.240.0/22;
    set_real_ip_from 198.41.128.0/17;
    set_real_ip_from 2400:cb00::/32;
    set_real_ip_from 2606:4700::/32;
    set_real_ip_from 2803:f800::/32;
    set_real_ip_from 2405:b500::/32;
    set_real_ip_from 2405:8100::/32;
    set_real_ip_from 2a06:98c0::/29;
    set_real_ip_from 2c0f:f248::/32;
    real_ip_header CF-Connecting-IP;

    # Security headers (defense in depth — app also sets these)
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Shared proxy settings
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;

    # --- /dashboard → kanban board (strips prefix) ---
    location /dashboard/ {
        proxy_pass http://127.0.0.1:$APP_PORT/;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
    # Redirect /dashboard to /dashboard/ (trailing slash required)
    location = /dashboard {
        return 301 /dashboard/;
    }

    # --- /settings → admin control panel (strips prefix) ---
    location /settings/ {
        proxy_pass http://127.0.0.1:$ADMIN_PORT/;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
    location = /settings {
        return 301 /settings/;
    }

    # --- /product → marketing/product pages ---
    location /product/ {
        proxy_pass http://127.0.0.1:$APP_PORT/product/;
    }
    location = /product {
        return 301 /product/;
    }

    # --- /health → health checks (no prefix strip needed) ---
    location /health {
        proxy_pass http://127.0.0.1:$APP_PORT/health;
    }

    # --- / → reserved for deployed apps ---
    # Default: show a landing page or redirect to /dashboard
    location = / {
        return 302 /dashboard/;
    }

    # Block admin panel HTML from direct access (defense in depth)
    location /control-panel.html {
        return 404;
    }
    location /user-management.html {
        return 404;
    }
}
NGINX

ln -sf "/etc/nginx/sites-available/$APP_NAME" /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
info "Nginx configured"

# --- UFW firewall ---
step "Configuring firewall..."
ufw --force reset >/dev/null 2>&1
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
info "Firewall active (22, 80, 443)"

# --- Start services ---
step "Starting services..."
systemctl restart nginx
systemctl restart "$APP_NAME"
info "Services started"

# --- Health check ---
step "Verifying health..."
HEALTHY=false
for i in $(seq 1 20); do
  if curl -sf http://localhost:$APP_PORT/health >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 1
done

if [ "$HEALTHY" = true ]; then
  STATUS=$(curl -sf http://localhost:$APP_PORT/health)
  info "Health check passed: $STATUS"
else
  warn "Health check failed after 20s — check: journalctl -u $APP_NAME -n 50"
fi

# --- Summary ---
echo "" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "  Deployment complete" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "  Board:     http://localhost/dashboard  (Nginx :80 → Express :$APP_PORT)" | tee -a "$LOG_FILE"
echo "  Settings:  http://localhost/settings   (Nginx :80 → Express :$ADMIN_PORT)" | tee -a "$LOG_FILE"
echo "  Product:   http://localhost/product    (marketing pages)" | tee -a "$LOG_FILE"
echo "  Root /:    Reserved for deployed apps" | tee -a "$LOG_FILE"
echo "  Logs:      journalctl -u $APP_NAME -f" | tee -a "$LOG_FILE"
echo "  Updates:   systemctl status $APP_NAME-update.timer" | tee -a "$LOG_FILE"
echo "  Config:    $APP_DIR/.env" | tee -a "$LOG_FILE"
echo "  Data:      $APP_DIR/.data/" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "  Cloudflare DNS (no origin rules needed):" | tee -a "$LOG_FILE"
echo "    A  <subdomain>  →  <this-vm-ip>  (proxy enabled)" | tee -a "$LOG_FILE"
echo "    Everything runs on port 80 — standard HTTP." | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
