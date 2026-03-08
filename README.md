# Claude Kanban

[![CI](https://github.com/divyamohan1993/claude-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/divyamohan1993/claude-kanban/actions/workflows/ci.yml)
[![CodeQL](https://github.com/divyamohan1993/claude-kanban/actions/workflows/codeql.yml/badge.svg)](https://github.com/divyamohan1993/claude-kanban/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Autonomous AI workflow board that orchestrates parallel Claude Code sessions.**

Drop an idea, pick a folder, walk away. Claude brainstorms the spec, builds the code, reviews its own work, auto-fixes issues, and commits to git. You only step in when it can't fix itself.

**4 dependencies. Zero build step. One command to start.**

## How It Works

```
Idea → Folder picker → Brainstorm (Claude generates spec)
  → Snapshot (saves pre-work state for rollback)
  → Build queue (respects dependencies + concurrency)
  → Build (Claude codes the feature)
  → AI Review (separate Claude session scores 1-10)
       → Score ≥ 8, no criticals → Auto-approve
       → Score 5-7 → Auto-fix + re-review (up to 3 cycles)
       → Score < 5 or criticals → Human review
  → Approve → CHANGELOG + git commit + push
  → Reject → Full rollback to snapshot + cascade-block dependents
```

Every step runs as a silent background process. The board updates in real-time via SSE.

## Features

**Pipeline**
- Zero-touch build-review-ship cycle — create a card, everything else is automatic
- Per-project work queue with configurable concurrency
- Card dependencies — builds respect ordering, blocked cards auto-unblock
- Activity-based timeout — kills stalled builds after configurable idle period
- Pipeline pause/resume, kill all, stop individual cards

**Quality**
- AI code review gate — separate Claude session scores quality, security, accessibility (1-10)
- 3-attempt auto-fix loop — score 5-7 triggers fix + re-review before human escalation
- Scoped review — reviewer only evaluates what the card was supposed to build
- File snapshot/rollback — reject restores every file to pre-work state
- Cascade revert — rejecting a card blocks all dependent cards

**Self-Healing**
- DB error scanner — runs every 30s, groups errors by card, auto-fixes (2 attempts), escalates
- Intelligence engine — learns from your patterns: auto-labels cards, tracks durations, auto-tunes config
- Checkpoint/rollback — every auto-change creates a revert point

**Board**
- Real-time SSE updates, drag-and-drop, 9-step pipeline progress visualization
- Labels, search, diff viewer, inline file editing, spec editing
- Dark mode (system-aware), responsive (mobile → 4K), keyboard shortcuts
- Desktop notifications, bulk import/export, webhooks
- Metrics dashboard — scores, durations, completions by day

**Operations**
- Two-server architecture — public board + localhost-only admin panel
- Control panel — usage tracking, backups, config, custom prompts, housekeeping
- Tiered backups — hot (5min), hourly (24), daily (configurable retention)
- Factory reset with double confirmation
- SSO auth — JWT + Argon2id, role-based access (admin/user/guest)
- Deep health checks — `/health` (liveness) + `/health/ready` (readiness)

## Quick Start

**Prerequisite:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

### Auto-install (recommended)

Installs Node.js, pnpm, and dependencies if missing. Safe to re-run.

```bash
# macOS / Linux
chmod +x start.sh stop.sh
./start.sh

# Windows
start.bat
```

### Manual

```bash
pnpm install
pnpm start
```

### Stop

```bash
# macOS / Linux
./stop.sh

# Windows
stop.bat
```

### Access

| Server | URL | Access |
|--------|-----|--------|
| Kanban Board | `http://localhost:51777` | Network (0.0.0.0) |
| Control Panel | `http://localhost:<admin-port>` | Localhost only (127.0.0.1) |

The admin port is randomized each start for security. Check the server log for the URL, or click the gear icon in the board header.

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `51777` | Public server port |
| `ADMIN_PORT` | *random* | Admin server port (randomized each start if unset) |
| `ADMIN_PASSWORD` | *(required)* | Admin login password |
| `USER_PASSWORD` | *(required)* | User login password |
| `PROJECTS_ROOT` | `~/Projects` | Root folder for project picker |
| `MAX_CONCURRENT_BUILDS` | `1` | Simultaneous Claude sessions |
| `BUILD_TIMEOUT_MINS` | `60` | Hard build timeout |
| `IDLE_TIMEOUT_MINS` | `15` | No-activity timeout (kills stalled builds) |
| `BACKUP_RETENTION_DAYS` | `7` | Daily backup retention |
| `USAGE_PAUSE_PCT` | `80` | Auto-pause pipeline at this Claude Max usage % |
| `MAX_HOURLY_SESSIONS` | `0` | Board-level hourly limit (0 = unlimited) |
| `MAX_WEEKLY_SESSIONS` | `0` | Board-level weekly limit (0 = unlimited) |
| `WEBHOOK_URL` | — | Outbound webhook for card state changes |
| `KANBAN_MODE` | `global` | `global` (multi-project) or `single-project` (autonomous) |

All config is live-editable from the control panel without restart.

## Project Structure

```
src/
  server.js                Express API + SSE + self-healing scanner
  config.js                All configuration constants + runtime config
  db/
    index.js               SQLite schema, prepared statements, backup system
  lib/
    logger.js              Pino structured JSON logging
    broadcast.js           SSE event broadcaster
    helpers.js              Utility functions
    process-manager.js     Process lifecycle management
  middleware/
    security.js            CSP, HSTS, CORS, input validation
    rate-limit.js          Token bucket rate limiter + SSE guard
  routes/
    public.js              Kanban CRUD, pipeline, brainstorm/build/review APIs
    admin.js               Control panel APIs — config, usage, backups
  services/
    pipeline.js            Build queue orchestration, work distribution
    brainstorm.js          Claude brainstorm + decompose flow
    review.js              AI code review + scoring + auto-fix
    auto-discover.js       Single-project mode discovery
    intelligence.js        Self-learning pattern engine
    snapshot.js            File snapshot/rollback
    git.js                 Git operations — commit, push, changelog
    usage.js               Claude Max usage tracking
    support.js             Housekeeping, backups
    claude-runner.js       Claude CLI process spawning
  sso/
    index.js               SSO middleware + session management
    jwt.js                 JWT token generation/verification
    users.js               User management + Argon2id hashing
    session-store.js       Session storage (10K cap, LRU eviction)
    views/login.html       Login page
public/
  index.html               Kanban board
  app.js                   Frontend logic — SSE, drag-drop, modals, pipeline
  style.css                Anthropic-branded theme (light + dark)
  control-panel.html       Enterprise admin dashboard
.data/                     Runtime artifacts (gitignored, auto-created)
  kanban.db                SQLite database
  logs/                    Build/review/fix logs per card
  snapshots/               File state snapshots for rollback
  backups/                 Tiered: hot/ hourly/ daily/
  runtime/                 Generated scripts for Claude sessions
```

## Stack

| Layer | Tech |
|-------|------|
| Server | Express 4, two-server architecture |
| Database | SQLite (better-sqlite3, WAL mode) |
| Auth | JWT (HS256) + Argon2id (64MB, OWASP params) |
| Logging | Pino structured JSON with correlation IDs |
| Frontend | Vanilla JS — no framework, no build step |
| AI | Claude Code CLI (configurable model + effort) |

## API

### Public Server

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/cards` | List all cards |
| `POST` | `/api/cards` | Create card |
| `PUT` | `/api/cards/:id` | Update card |
| `DELETE` | `/api/cards/:id` | Soft-delete card |
| `POST` | `/api/cards/:id/move` | Move to column |
| `POST` | `/api/cards/:id/brainstorm` | Start brainstorm |
| `POST` | `/api/cards/:id/start-work` | Queue build |
| `POST` | `/api/cards/:id/approve` | Approve + commit |
| `POST` | `/api/cards/:id/reject` | Reject + rollback |
| `POST` | `/api/cards/:id/retry` | Retry with feedback |
| `POST` | `/api/cards/:id/stop` | Stop active build |
| `PUT` | `/api/cards/:id/spec` | Update spec |
| `PUT` | `/api/cards/:id/labels` | Update labels |
| `PUT` | `/api/cards/:id/depends-on` | Set dependencies |
| `GET` | `/api/cards/:id/diff` | Snapshot vs current diff |
| `POST` | `/api/cards/:id/edit-file` | Inline file edit |
| `GET` | `/api/cards/:id/log/:type` | Read log file |
| `GET` | `/api/cards/:id/log-stream` | SSE live log |
| `GET` | `/api/pipeline` | Pipeline state |
| `POST` | `/api/pipeline/pause` | Pause pipeline |
| `POST` | `/api/pipeline/resume` | Resume pipeline |
| `POST` | `/api/pipeline/kill-all` | Kill all + pause |
| `GET` | `/api/events` | SSE event stream |
| `GET` | `/api/search?q=` | Search cards |
| `GET` | `/api/metrics` | Board metrics |
| `GET` | `/api/export` | Export board JSON |
| `POST` | `/api/bulk-create` | Bulk import |
| `GET` | `/health` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe |

### Admin Server (localhost only)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET/PUT` | `/api/config` | Runtime configuration |
| `GET/PUT` | `/api/custom-prompts` | Brainstorm/build/review instructions |
| `GET` | `/api/usage` | Claude Max usage stats |
| `GET` | `/api/backups` | List all backups |
| `POST` | `/api/backups/create` | Create manual backup |
| `POST` | `/api/backups/restore` | Restore from backup |
| `GET` | `/api/errors` | Unresolved errors |
| `GET` | `/api/intelligence` | Learned patterns |
| `POST` | `/api/factory-reset` | Full wipe (requires confirmation) |

## Security

Two completed security audits (41 findings, 35 fixed). See [SECURITY-AUDIT.md](SECURITY-AUDIT.md).

**Highlights:**
- Admin server binds to `127.0.0.1` only — kernel-level TCP reject from external IPs
- Argon2id password hashing (64MB memory, 3 iterations, timing-safe)
- JWT with randomized secret per instance
- Rate limiting (token bucket, 60 req/s burst) + SSE connection cap
- CSP, HSTS, CORS, secure cookies, CSRF protection
- Path traversal protection on all file operations
- Command injection blocking on all spawn sites
- Input validation with length limits on all endpoints
- Webhook SSRF protection (blocks internal IPs)
- Graceful shutdown with connection draining

## Platform Support

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Silent Claude sessions | `.bat` wrappers | `.sh` scripts | `.sh` scripts |
| Process management | `taskkill /T` | `kill` (process group) | `kill` (process group) |
| Auto-install | winget | Homebrew | apt/dnf/pacman/zypper/apk |
| Open IDE | `code` | `code` | `code` |

## Requirements

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, authenticated
- pnpm (auto-installed by start scripts)

## License

[MIT](LICENSE) — Divya Mohan
