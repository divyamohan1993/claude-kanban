# Deployment

## Requirements

- **Node.js 18+** — Auto-installed by start scripts if missing
- **pnpm** — Auto-installed if missing
- **Claude Code CLI** — Must be installed and authenticated separately
- **OS**: Windows, macOS, or Linux (Ubuntu, Debian, Fedora, Arch, Alpine, openSUSE)

## Start Scripts

### Linux / macOS (`start.sh`)

```bash
chmod +x start.sh stop.sh
./start.sh
```

What it does:
1. Checks if the server is already running (PID file)
2. Installs Node.js if missing (Homebrew on macOS, apt/dnf/pacman/zypper/apk on Linux)
3. Installs pnpm if missing
4. Runs `pnpm install --frozen-lockfile`
5. Starts the server in the background with `nohup`
6. Waits for PID file confirmation

### Windows (`start.bat`)

```cmd
start.bat
```

Same steps but uses `winget` for Node.js and `Start-Process -WindowStyle Hidden` for invisible background operation.

### Manual

```bash
pnpm install
pnpm start        # foreground
pnpm dev          # foreground with --watch auto-reload
```

## Stop Scripts

```bash
./stop.sh         # Linux/macOS: SIGTERM → wait → SIGKILL
stop.bat          # Windows: taskkill /T /F
```

Both read the PID from `.data/server.pid` and clean up.

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

## Platform Notes

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Silent Claude sessions | `.bat` wrappers with `windowsHide: true` | `.sh` scripts | `.sh` scripts |
| Process kill | `taskkill /PID /T /F` | `kill` (process group) | `kill` (process group) |
| Auto-install Node | `winget` | Homebrew | apt/dnf/pacman/zypper/apk |
| Open VS Code | `code` | `code` | `code` |
| Terminal | `cmd` | Terminal.app | gnome-terminal / xterm |

## Production Hardening

Before exposing to a network:

1. **Set passwords** — `ADMIN_PASSWORD` and `USER_PASSWORD` in `.env`. Default credentials log a loud warning.
2. **Pin admin port** — Set `ADMIN_PORT` in `.env` if you need a stable URL (e.g., behind nginx).
3. **HTTPS** — Put a reverse proxy (nginx, Caddy, Cloudflare) in front. The server auto-enables HSTS when it detects `X-Forwarded-Proto: https`.
4. **Secure cookies** — Set `NODE_ENV=production` or `SECURE_COOKIES=true` for the `Secure` cookie flag.
5. **Firewall** — Only port 51777 needs to be exposed. The admin port should never be reachable externally (it's already localhost-bound, but defense in depth).
6. **Backups** — Enabled by default. Verify `.data/backups/` is on a different disk or synced offsite for DR.

## Health Checks

| Endpoint | Type | Checks |
|----------|------|--------|
| `GET /health` | Liveness | Server is running (always 200) |
| `GET /health/ready` | Readiness | DB integrity, disk writability, pipeline state, unresolved error count |

`/health/ready` returns 503 with a `degraded` status if any check fails. Use this for monitoring or load balancer health probes.
