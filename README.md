# Claude Kanban

**Autonomous AI workflow board that orchestrates parallel Claude Code sessions.**

Drop a card, pick a folder, and walk away. Claude brainstorms the spec, builds the code, reviews its own work, auto-fixes issues (up to 3 attempts), and commits to git. You only intervene when it can't fix itself.

## How It Works

```
Card created
  |-> Folder picker (human confirms target project)
  |-> Brainstorm (Claude generates spec, silent background process)
  |-> Auto-queue build (respects dependencies + concurrency limit)
  |-> Snapshot (pre-work file state saved for rollback)
  |-> Build (Claude codes the feature, polls for completion)
  |-> AI Review (separate Claude scores 1-10)
       |-> Score >= 8, no criticals -> Auto-approve
       |-> Score 5-7 -> Auto-fix + re-review (up to 3 cycles)
       |-> Score < 5 or criticals -> Human review
  |-> Approve -> CHANGELOG + git commit + push
  |-> Reject -> Full file rollback to snapshot + cascade-block dependents
```

## Features

- **Zero-touch pipeline** -- Create a card and the entire build-review-ship cycle runs autonomously
- **Per-project work queue** -- Configurable concurrency limit, cards wait their turn
- **AI code review gate** -- Separate Claude session scores quality, security, accessibility (1-10)
- **3-attempt auto-fix loop** -- Score 5-7 triggers Claude to fix findings, then re-reviews (max 3 cycles before human escalation)
- **Self-healing** -- Server scans logs every 30s, auto-fixes errors (2 attempts), escalates to human
- **File snapshot/rollback** -- Full pre-work state saved, reject restores everything
- **Cascade revert** -- Rejecting a card auto-blocks all dependent cards
- **Live log streaming** -- SSE-powered real-time build/review output in browser
- **9-step pipeline visualization** -- Progress bar on each card
- **Pipeline controls** -- Pause/resume, kill all, stop individual cards
- **Card dependencies** -- Build order respected, blocked cards auto-unblock when deps complete
- **Labels, search, diff viewer** -- Tag cards, search across board, view file-level diffs
- **Dark mode** -- System-preference-aware toggle, persisted in localStorage
- **Responsive design** -- Mobile, tablet, desktop, 4K layouts
- **Desktop notifications** -- Browser alerts when cards complete or need attention
- **Keyboard shortcuts** -- N (new), / (search), D (dark mode), M (metrics), A (archive), ? (help)
- **Bulk import/export** -- Import cards one-per-line, export full board JSON
- **Webhooks** -- Outbound notifications on card state changes
- **Control panel** -- Enterprise admin dashboard for config, usage, backups, housekeeping
- **Usage tracking** -- Real Claude Max usage monitoring with auto-pause at configurable threshold
- **Tiered backups** -- Hot (5min), hourly (24), daily (configurable retention) with timeline-based DR restore
- **Factory reset** -- Double-confirmation wipe for fresh start
- **Periodic housekeeping** -- Auto-cleans old logs, stale scripts, excess audit rows

## Stack

| Layer | Tech |
|-------|------|
| Server | Express, two-server architecture (public + admin) |
| Database | SQLite (better-sqlite3, WAL mode) |
| Frontend | Vanilla JS, no framework, no build step |
| AI | Claude CLI (configurable model + effort) |
| Process | `.bat`/`.sh` wrappers, `windowsHide: true` |

## Quick Start

**Prerequisites:** [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

**Fresh machine (auto-installs Node, pnpm, dependencies):**

```bash
# macOS / Linux
chmod +x start.sh stop.sh
./start.sh

# Windows
start.bat
```

**Stop:**

```bash
# macOS / Linux
./stop.sh

# Windows
stop.bat
```

**Manual (if you already have Node 18+ and pnpm):**

```bash
pnpm install
pnpm start
```

**Two servers start automatically:**

| Server | URL | Access |
|--------|-----|--------|
| Kanban Board | `http://localhost:51777` | Public (0.0.0.0) |
| Control Panel | `http://localhost:51778` | Localhost only (127.0.0.1) |

Configure ports via `PORT` and `ADMIN_PORT` in `.env`. Control panel access can be PIN-protected via `ADMIN_PIN`.

### What the start scripts do

1. Check if the server is already running (skip if so)
2. Install Node.js if missing (brew/apt/dnf/pacman/zypper/apk/winget)
3. Install pnpm if missing
4. Run `pnpm install` to fetch/update dependencies
5. Start the server in the background
6. Open the browser automatically

The scripts are idempotent -- safe to re-run at any time.

## Project Structure

```
server.js              Express API + SSE + self-healing log scanner + housekeeping
orchestrator.js        Claude CLI spawning, brainstorm/build/review, work queue, config
db.js                  SQLite schema + prepared statements + tiered backup system
snapshot.js            File snapshot/rollback for reject + revert
start.sh / start.bat   Start scripts (auto-install deps, background server)
stop.sh / stop.bat     Stop scripts
public/
  index.html           Kanban board shell + modals
  app.js               Frontend logic, SSE, drag-and-drop, pipeline rendering
  style.css            Anthropic-branded theme (light + dark)
  control-panel.html   Enterprise admin dashboard
.data/                 Runtime (gitignored, auto-created)
  kanban.db            SQLite database
  logs/                Build/review/fix log files
  snapshots/           File snapshots for rollback/revert
  backups/
    hot/               Latest backup (every 5 min)
    hourly/            Hourly backups (keep 24)
    daily/             Daily backups (configurable retention)
  runtime/             Generated .bat/.sh scripts for Claude sessions
  server.pid           PID file for stop script
  server.log           Server stdout/stderr
  custom-prompts.json  Custom brainstorm/build/review instructions
```

## API

### Public (port 51777)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/cards` | List all cards |
| POST | `/api/cards` | Create card |
| PUT | `/api/cards/:id` | Update card |
| DELETE | `/api/cards/:id` | Soft-delete card |
| POST | `/api/cards/:id/move` | Move to column |
| POST | `/api/cards/:id/brainstorm` | Start brainstorm |
| POST | `/api/cards/:id/start-work` | Queue build |
| POST | `/api/cards/:id/approve` | Approve + commit |
| POST | `/api/cards/:id/reject` | Reject + rollback + cascade-block |
| POST | `/api/cards/:id/revert-files` | Revert files to pre-work state |
| POST | `/api/cards/:id/retry` | Retry with feedback |
| POST | `/api/cards/:id/stop` | Stop active build |
| PUT | `/api/cards/:id/spec` | Update spec |
| PUT | `/api/cards/:id/labels` | Update labels |
| PUT | `/api/cards/:id/depends-on` | Update dependencies |
| GET | `/api/cards/:id/diff` | Snapshot vs current diff |
| POST | `/api/cards/:id/edit-file` | Inline file edit |
| POST | `/api/cards/:id/preview` | Preview/run command |
| GET | `/api/cards/:id/has-snapshot` | Check if snapshot exists |
| GET | `/api/cards/:id/log/:type` | Read log file |
| GET | `/api/cards/:id/log-stream` | SSE live log |
| GET | `/api/archive` | List archived cards |
| POST | `/api/cards/:id/unarchive` | Restore from archive |
| GET | `/api/search?q=` | Search cards |
| GET | `/api/export` | Export board JSON |
| POST | `/api/bulk-create` | Bulk import cards |
| GET | `/api/metrics` | Board metrics |
| GET | `/api/queue` | Work queue status |
| GET | `/api/activities` | Pipeline activities |
| GET | `/api/pipeline` | Pipeline state |
| POST | `/api/pipeline/pause` | Pause pipeline |
| POST | `/api/pipeline/resume` | Resume pipeline |
| POST | `/api/pipeline/kill-all` | Kill all + pause |
| GET | `/api/events` | SSE event stream |
| GET | `/api/admin-info` | Admin port info |

### Admin (port 51778, localhost only)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/config` | Read runtime config |
| PUT | `/api/config` | Update runtime config |
| GET | `/api/custom-prompts` | Read custom prompts |
| PUT | `/api/custom-prompts` | Update custom prompts |
| GET | `/api/usage` | Claude Max usage stats |
| POST | `/api/usage/refresh` | Force usage refresh |
| GET | `/api/backups` | List all backups |
| POST | `/api/backups/create` | Create manual backup |
| POST | `/api/backups/restore` | Restore from backup |
| GET | `/api/housekeeping` | Disk usage stats |
| POST | `/api/housekeeping/run` | Run cleanup now |
| POST | `/api/factory-reset` | Wipe all data + restart |
| POST | `/api/admin/verify` | Verify admin PIN |

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `51777` | Public server port |
| `ADMIN_PORT` | `PORT + 1` | Admin server port |
| `ADMIN_PIN` | *(empty)* | PIN for admin write APIs |
| `PROJECTS_ROOT` | `R:\` (Win) / `~/Projects` | Root folder for project picker |
| `MAX_CONCURRENT_BUILDS` | `1` | Simultaneous Claude sessions |
| `BUILD_TIMEOUT_MINS` | `60` | Hard build timeout |
| `IDLE_TIMEOUT_MINS` | `15` | No-activity timeout |
| `BACKUP_RETENTION_DAYS` | `7` | Daily backup retention |
| `USAGE_PAUSE_PCT` | `80` | Auto-pause at this usage % |
| `MAX_HOURLY_SESSIONS` | `0` | Board-level hourly limit (0 = off) |
| `MAX_WEEKLY_SESSIONS` | `0` | Board-level weekly limit (0 = off) |
| `WEBHOOK_URL` | *(empty)* | Outbound webhook URL |

## Requirements

- **Windows**, **macOS**, or **Linux** (Ubuntu, Debian, Fedora, Arch, etc.)
- Node.js 18+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) authenticated with `--dangerously-skip-permissions`
- pnpm

### Platform Notes

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Silent Claude | `.bat` wrappers | `.sh` scripts | `.sh` scripts |
| Process kill | `taskkill /T` | `kill -9` (process group) | `kill -9` (process group) |
| Open terminal | `cmd` | Terminal.app | gnome-terminal / xterm |
| Open browser | `start` | `open` | `xdg-open` |
| Default projects dir | `R:\` | `~/Projects` | `~/Projects` |

Override the projects directory with `PROJECTS_ROOT` env var.

## License

MIT
