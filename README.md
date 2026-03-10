# Claude Kanban

[![CI](https://github.com/divyamohan1993/claude-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/divyamohan1993/claude-kanban/actions/workflows/ci.yml)
[![CodeQL](https://github.com/divyamohan1993/claude-kanban/actions/workflows/codeql.yml/badge.svg)](https://github.com/divyamohan1993/claude-kanban/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Tests](https://img.shields.io/badge/tests-305%20passing-brightgreen)]()

**Drop an idea. Walk away. Come back to committed code.**

Claude Kanban orchestrates autonomous Claude Code sessions as a zero-touch build-review-ship pipeline. You describe what you want; AI brainstorms, builds, reviews, fixes, and commits. You only step in when it can't fix itself.

```
Idea -> Brainstorm -> Snapshot -> Build -> AI Review (1-10)
  >=8  Auto-approve, git commit + push
  5-7  Auto-fix, re-review (up to 3 cycles)
  <5   Human review
```

5 dependencies. Zero build step. One command to start.

## Quick Start

**Prerequisite:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

```bash
# macOS / Linux
scripts/start.sh

# Windows
scripts\start.bat

# Or manual
pnpm install && pnpm start
```

Open `http://localhost:51777`.

Stop with `scripts/stop.sh` or `scripts\stop.bat`.

## Deploy

| Method | Command | Use case |
|--------|---------|----------|
| **Local** | `scripts/start.sh` | Dev, testing |
| **GCP Ubuntu** | `sudo bash autoconfig.sh` | Production (systemd, Nginx, auto-update, UFW) |
| **Docker** | `docker build -f deploy/Dockerfile -t claude-kanban .` | Containers |
| **Docker Compose** | `cd deploy && docker compose up -d` | Self-hosting |
| **Kubernetes** | `kubectl apply -k deploy/k8s/` | Orchestrated |

See [Deployment](docs/deployment.md) for full details.

## What It Does

**Pipeline** -- Create a card, pick a project folder, and the full cycle runs autonomously: brainstorm spec, snapshot files, build, AI review (1-10 score), auto-fix if needed, commit on approve, rollback on reject. Card dependencies respected. Concurrency configurable.

**Self-healing** -- Error scanner runs every 30s, groups failures by card, auto-fixes (2 attempts), escalates to a new card if it can't. Intelligence engine learns patterns, auto-labels cards, tunes timeouts.

**Board** -- Real-time SSE updates. Drag-and-drop. 9-step progress visualization. Labels, search, diff viewer, inline file editing. Dark mode. WCAG 2.2 AAA. Keyboard shortcuts (`N` new, `/` search, `D` dark mode).

**Security** -- Two-server architecture: public board on `0.0.0.0`, admin panel on `127.0.0.1` (kernel-level TCP reject). Argon2id passwords, AES-256-GCM field encryption, JWT auth, CSP nonce, CSRF protection, token bucket rate limiting. Role hierarchy: superadmin > admin > user.

**Ops** -- Tiered backups (5min/hourly/daily). Factory reset. Health probes (`/health`, `/health/ready`). Structured JSON logging (pino). Heartbeat watchdog. Graceful shutdown with pipeline drain.

## Trust

305 automated tests across 5 suites. [View the report](public/product/trust/).

| Suite | Tests |
|-------|-------|
| Reliability | 168 |
| Dependency Audit | 27 |
| Performance | 28 |
| Data Durability | 35 |
| Code Quality | 47 |

```bash
pnpm test              # all suites
pnpm test:reliability  # single suite
```

## Documentation

| Document | Content |
|----------|---------|
| [Architecture](docs/architecture.md) | Two-server design, service layer, database schema |
| [Pipeline](docs/pipeline.md) | Build-review-ship cycle, auto-fix loop, self-healing |
| [API Reference](docs/api.md) | 91 endpoints with examples |
| [Configuration](docs/configuration.md) | All environment variables |
| [Deployment](docs/deployment.md) | Local, Docker, K8s, GCP autoconfig |
| [Security Audit](docs/security-audit.md) | Three audits, 35 findings + 72 CodeQL alerts fixed |

## License

[Apache 2.0](LICENSE) -- [Divya Mohan](https://dmj.one)

See [NOTICE](NOTICE) for attribution requirements.
