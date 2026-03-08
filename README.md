# Claude Kanban

[![CI](https://github.com/divyamohan1993/claude-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/divyamohan1993/claude-kanban/actions/workflows/ci.yml)
[![CodeQL](https://github.com/divyamohan1993/claude-kanban/actions/workflows/codeql.yml/badge.svg)](https://github.com/divyamohan1993/claude-kanban/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

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

## Documentation

| Document | What you'll learn |
|----------|-------------------|
| [Architecture](docs/architecture.md) | Two-server design, service layer, database schema, how it all fits together |
| [Pipeline](docs/pipeline.md) | Build-review-ship cycle, auto-fix loop, queue mechanics, self-healing |
| [API Reference](docs/api.md) | All 79 endpoints — public, admin, SSE, health checks |
| [Configuration](docs/configuration.md) | Every environment variable, runtime config, custom prompts |
| [Deployment](docs/deployment.md) | Start/stop scripts, platform support, production hardening |
| [Security Audit](docs/security-audit.md) | Two audits, 41 findings, 35 fixed — full remediation log |

## License

[Apache 2.0](LICENSE) — [Divya Mohan](https://dmj.one)

See [NOTICE](NOTICE) for attribution requirements.
