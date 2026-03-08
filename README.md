# Claude Kanban

[![CI](https://github.com/divyamohan1993/claude-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/divyamohan1993/claude-kanban/actions/workflows/ci.yml)
[![CodeQL](https://github.com/divyamohan1993/claude-kanban/actions/workflows/codeql.yml/badge.svg)](https://github.com/divyamohan1993/claude-kanban/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Drop an idea. Walk away. Come back to committed code.**

Claude Kanban orchestrates autonomous Claude Code sessions — brainstorm, build, review, fix, commit — as a zero-touch pipeline. You describe what you want. AI does the rest. You only step in when it can't fix itself.

```
Idea → Brainstorm → Snapshot → Build → AI Review (1-10)
  ≥8 → Auto-approve → git commit + push
  5-7 → Auto-fix → Re-review (up to 3 cycles)
  <5 → Human review
```

4 dependencies. Zero build step. One command to start.

## Why

Every AI coding tool today requires you to sit and watch. Prompt, wait, review, re-prompt, repeat. Claude Kanban turns that into a production line — queue up 10 cards, close your laptop, come back to reviewed and committed code. A separate AI session reviews every build, auto-fixes what it can, and only escalates what it can't.

## Quick Start

**Prerequisite:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

```bash
# macOS / Linux
chmod +x start.sh && ./start.sh

# Windows
start.bat
```

Open `http://localhost:51777`. That's it.

The start script installs Node.js, pnpm, and dependencies if missing. Safe to re-run. Stop with `./stop.sh` or `stop.bat`.

## What It Does

**The pipeline** — Create a card, pick a project folder, and the full cycle runs autonomously: brainstorm spec, snapshot files, build, AI review (1-10 score), auto-fix if needed, commit on approve, rollback on reject. Card dependencies respected. Concurrency configurable.

**Self-healing** — Error scanner runs every 30 seconds, groups failures by card, auto-fixes (2 attempts), escalates to a new card if it can't. The intelligence engine learns from your patterns — auto-labels cards, tracks build durations, tunes timeouts.

**The board** — Real-time SSE updates. Drag-and-drop. 9-step progress visualization. Labels, search, diff viewer, inline file editing. Dark mode. Responsive from mobile to 4K. Keyboard shortcuts (`N` new, `/` search, `D` dark mode).

**Operations** — Two-server architecture: public board on `0.0.0.0`, admin panel on `127.0.0.1` only (kernel-level TCP reject). Tiered backups (5min/hourly/daily). Factory reset. SSO auth with Argon2id + JWT. Health probes at `/health` and `/health/ready`.

## Configuration

Copy `.env.example` to `.env`. Everything is also live-editable from the control panel (gear icon in header).

Key settings: `PORT` (default 51777), `PROJECTS_ROOT` (default ~/Projects), `MAX_CONCURRENT_BUILDS` (default 1), `BUILD_TIMEOUT_MINS` (default 60), `ADMIN_PASSWORD` / `USER_PASSWORD` (required for production). See [.env.example](.env.example) for full reference.

## Security

Two audits, 41 findings, 35 fixed. Argon2id passwords, JWT auth, rate limiting, CSP/HSTS/CORS, path traversal protection, command injection blocking, SSRF protection, graceful shutdown. Full details in [SECURITY-AUDIT.md](SECURITY-AUDIT.md).

## Stack

Express 4 + SQLite (WAL) + Vanilla JS. No framework, no build step, no bundler. Pino structured logging. Cross-platform (Windows `.bat` / Unix `.sh` wrappers).

## Requirements

- Node.js 18+ (auto-installed by start scripts)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, authenticated
- pnpm (auto-installed by start scripts)

<details>
<summary><strong>API Reference</strong></summary>

### Public Server (port 51777)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET/POST` | `/api/cards` | List / create cards |
| `PUT/DELETE` | `/api/cards/:id` | Update / soft-delete |
| `POST` | `/api/cards/:id/brainstorm` | Generate spec |
| `POST` | `/api/cards/:id/start-work` | Queue build |
| `POST` | `/api/cards/:id/approve` | Approve + commit |
| `POST` | `/api/cards/:id/reject` | Reject + rollback |
| `POST` | `/api/cards/:id/retry` | Retry with feedback |
| `POST` | `/api/cards/:id/stop` | Stop active build |
| `GET` | `/api/cards/:id/diff` | Snapshot vs current |
| `GET` | `/api/cards/:id/log-stream` | SSE live log |
| `GET/POST` | `/api/pipeline/*` | Pipeline state + controls |
| `GET` | `/api/events` | SSE event stream |
| `GET` | `/api/search?q=` | Search cards |
| `GET` | `/api/metrics` | Board metrics |
| `GET` | `/health` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe |

### Admin Server (localhost only)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET/PUT` | `/api/config` | Runtime configuration |
| `GET/PUT` | `/api/custom-prompts` | AI instructions |
| `GET` | `/api/usage` | Claude Max usage |
| `GET/POST` | `/api/backups/*` | Backup management |
| `GET` | `/api/intelligence` | Learned patterns |
| `POST` | `/api/factory-reset` | Full wipe |

</details>

## License

[MIT](LICENSE) — [Divya Mohan](https://dmj.one)
