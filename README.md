# Claude Kanban

**Autonomous AI workflow board that orchestrates parallel Claude Code sessions.**

Drop a card, pick a folder, and walk away. Claude brainstorms the spec, builds the code, reviews its own work, auto-fixes issues, and commits to git. You only intervene when it can't fix itself.

## How It Works

```
Card created
  |-> Folder picker (human confirms target project)
  |-> Brainstorm (Claude generates spec, silent background process)
  |-> Auto-queue build
  |-> Snapshot (pre-work file state saved for rollback)
  |-> Build (Claude codes the feature, polls for completion)
  |-> AI Review (separate Claude scores 1-10)
       |-> Score >= 8, no criticals -> Auto-approve
       |-> Score 5-7 -> Auto-fix, then re-review
       |-> Score < 5 or criticals -> Human review
  |-> Approve -> CHANGELOG + git commit + push
  |-> Reject -> Full file rollback to snapshot
```

## Features

- **Zero-touch pipeline** -- Create a card and the entire build-review-ship cycle runs autonomously
- **Per-project work queue** -- One build at a time per project path, cards wait their turn
- **AI code review gate** -- Separate Claude session scores quality, security, accessibility (1-10)
- **Auto-fix loop** -- Score 5-7 triggers Claude to fix review findings, then re-reviews (max 1 cycle)
- **Self-healing** -- Server scans logs every 30s, auto-fixes errors (2 attempts), escalates to human
- **File snapshot/rollback** -- Full pre-work state saved, reject restores everything
- **Live log streaming** -- SSE-powered real-time build/review output in browser
- **9-step pipeline visualization** -- Progress bar on each card (Folder > Spec > Queue > Snap > Build > Review > Fix > Approve > Done)
- **Drag-and-drop** -- Move cards between columns, auto-triggers appropriate actions
- **Auto-changelog + git commit** -- Approve generates changelog entry and commits with co-author
- **Real-time updates** -- SSE broadcasts all state changes, no polling

## Stack

| Layer | Tech |
|-------|------|
| Server | Express, port 51777 |
| Database | SQLite (better-sqlite3, WAL mode) |
| Frontend | Vanilla JS, no framework, no build step |
| AI | Claude CLI (`claude-opus-4-6`, `--effort high`) |
| Process | `.bat` wrappers, `windowsHide: true` |

## Quick Start

```bash
pnpm install
pnpm start
```

Opens `http://localhost:51777` automatically. Requires [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

## Project Structure

```
server.js        Express API + SSE + self-healing log scanner
orchestrator.js  Claude CLI spawning, brainstorm/build/review, work queue
db.js            SQLite schema + prepared statements
snapshot.js      File snapshot/rollback for reject flow
public/
  index.html     Shell + modals
  app.js         Frontend logic, SSE, drag-and-drop, pipeline rendering
  style.css      Dark theme, column colors, animations
```

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/cards` | List all cards |
| POST | `/api/cards` | Create card |
| PUT | `/api/cards/:id` | Update card |
| DELETE | `/api/cards/:id` | Delete card |
| POST | `/api/cards/:id/move` | Move to column |
| POST | `/api/cards/:id/brainstorm` | Start brainstorm |
| POST | `/api/cards/:id/start-work` | Queue build |
| POST | `/api/cards/:id/approve` | Approve + commit |
| POST | `/api/cards/:id/reject` | Reject + rollback |
| GET | `/api/cards/:id/log/:type` | Read log file |
| GET | `/api/cards/:id/log-stream` | SSE live log |
| GET | `/api/cards/:id/review` | Review findings |
| GET | `/api/queue` | Work queue status |
| GET | `/api/activities` | Pipeline activities |
| GET | `/api/events` | SSE event stream |

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
