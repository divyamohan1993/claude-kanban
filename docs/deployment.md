# Deployment

## Requirements

- **Node.js 18+** — Auto-installed by start scripts if missing
- **pnpm** — Auto-installed if missing
- **Claude Code CLI** — Must be installed and authenticated separately
- **OS**: Windows, macOS, or Linux (Ubuntu, Debian, Fedora, Arch, Alpine, openSUSE)

## Quick Start (Local)

### Linux / macOS

```bash
chmod +x scripts/start.sh scripts/stop.sh
scripts/start.sh
```

What it does:
1. Checks if the server is already running (PID file)
2. Installs Node.js if missing (Homebrew on macOS, apt/dnf/pacman/zypper/apk on Linux)
3. Installs pnpm if missing
4. Runs `pnpm install --frozen-lockfile`
5. Starts the server in the background with `nohup`
6. Waits for PID file confirmation

### Windows

```cmd
scripts\start.bat
```

Same steps but uses `winget` for Node.js and `Start-Process -WindowStyle Hidden` for invisible background operation.

### Manual

```bash
pnpm install
pnpm start        # foreground
pnpm dev          # foreground with --watch auto-reload
```

## Stop

```bash
scripts/stop.sh         # Linux/macOS: SIGTERM -> wait -> SIGKILL
scripts\stop.bat        # Windows: taskkill /T /F
```

Both read the PID from `.data/server.pid` and clean up.

## Production (GCP Ubuntu)

Zero-intervention deploy from blank Ubuntu to running app:

```bash
sudo bash autoconfig.sh
```

What it sets up:
- Node.js 22, pnpm, build tools
- Systemd service (auto-restart on crash, survives reboot)
- Nginx reverse proxy on port 80 with path-based routing (`/dashboard/`, `/settings/`, `/product/`)
- UFW firewall (22, 80, 443)
- Hourly auto-update timer (git pull, drain pipeline, restart, rollback on failure)
- Cloudflare real-IP restoration

After deploy, add a Cloudflare DNS record:
- A `<subdomain>` -> `<vm-ip>` (proxy enabled)

Then authenticate Claude CLI for the app user:
```bash
sudo -u kanban claude auth login
```

## Docker

```bash
# Build
docker build -f deploy/Dockerfile -t claude-kanban .

# Run
docker run -d -p 51777:51777 -v kanban-data:/app/.data --env-file .env claude-kanban

# Or with Docker Compose
cd deploy && docker compose up -d
```

## Kubernetes

```bash
# Create secrets from .env
kubectl create secret generic claude-kanban-env --from-env-file=.env

# Deploy
kubectl apply -k deploy/k8s/
```

## Watchdog

For local deployments without systemd:

```bash
scripts/watchdog.sh             # Linux/macOS (foreground)
nohup scripts/watchdog.sh &     # Linux/macOS (background)
scripts\watchdog.bat            # Windows
```

Checks `.data/.heartbeat` every 60 seconds. If stale (>90s), kills orphaned processes and restarts.

## Graceful Shutdown

On `SIGTERM` or `SIGINT`, the server:
1. Stops accepting new connections
2. Drains in-flight requests (5s timeout)
3. Kills active Claude builds
4. Closes the database connection
5. Removes the PID file

## Data Directory

All runtime data lives in `.data/` (gitignored, auto-created on first start):

```
.data/
  kanban.db              SQLite database
  server.pid             Process ID for stop script
  server.log             Server stdout/stderr
  logs/                  Per-card build/review/fix logs
  snapshots/             Pre-work file snapshots
  archive/snapshots/     Archived snapshots
  backups/
    hot/                 Latest backup (every 5 minutes)
    hourly/              Hourly backups (keep 24)
    daily/               Daily backups (configurable retention)
  runtime/               Generated .bat/.sh scripts for Claude sessions
  custom-prompts.json    Custom brainstorm/build/review instructions
```

## Health Checks

| Endpoint | Type | Checks |
|----------|------|--------|
| `GET /health` | Liveness | Server is running (always 200) |
| `GET /health/ready` | Readiness | DB integrity, disk writability, pipeline state, unresolved error count |

`/health/ready` returns 503 with a `degraded` status if any check fails.
