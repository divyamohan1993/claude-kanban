# Architecture

## Overview

Claude Kanban is a Node.js application with two Express servers, a SQLite database, and a vanilla JS frontend. No build step, no bundler, no framework.

## Two-Server Design

```
┌──────────────────────────────┐     ┌──────────────────────────────┐
│     Public Server            │     │     Admin Server             │
│     0.0.0.0:51777            │     │     127.0.0.1:<random>       │
│                              │     │                              │
│  Kanban board (HTML/JS/CSS)  │     │  Control panel (HTML/JS)     │
│  Card CRUD + pipeline APIs   │     │  Config, backups, usage      │
│  SSE event stream            │     │  Intelligence, errors        │
│  Auth: open reads,           │     │  Auth: admin role required   │
│        authed writes         │     │  Binding: localhost only     │
└──────────────────────────────┘     └──────────────────────────────┘
              │                                   │
              └─────────────┬─────────────────────┘
                            │
                   ┌────────▼────────┐
                   │   SQLite (WAL)  │
                   │   .data/kanban  │
                   │   .db           │
                   └─────────────────┘
```

The admin server binds to `127.0.0.1` — not just filtered, but kernel-level TCP reject from any external IP. Even if you know the port, you can't reach it from outside the machine.

The admin port is randomized each start (49152–65535) unless pinned via `ADMIN_PORT` env var.

## Source Layout

```
src/
  server.js              ← Express app setup, middleware, SSE, startup
  config.js              ← All constants, runtime config, port generation

  db/index.js            ← SQLite schema (8 tables), prepared statements, backups

  lib/
    logger.js            ← Pino structured JSON logging + DB error hook
    broadcast.js         ← SSE broadcaster (card updates, log output, config changes)
    helpers.js           ← Shared utilities
    process-manager.js   ← Child process lifecycle (spawn, kill, track)

  middleware/
    security.js          ← CSP, HSTS, CORS, nonce, error handler
    rate-limit.js        ← Token bucket (60 req/s burst, 30/s refill) + SSE guard

  routes/
    public.js            ← All public API endpoints (cards, pipeline, search, etc.)
    admin.js             ← Admin-only endpoints (config, backups, intelligence, etc.)

  services/
    pipeline.js          ← Build queue, work distribution, lock management
    brainstorm.js        ← Claude brainstorm + decompose into child cards
    review.js            ← AI code review, scoring, auto-fix loop
    auto-discover.js     ← Single-project mode: TODO/FIXME scanning
    intelligence.js      ← Pattern learning, auto-labeling, config tuning
    snapshot.js          ← File snapshot before build, rollback on reject
    git.js               ← Commit, push, changelog generation
    usage.js             ← Claude Max usage tracking via Anthropic API
    support.js           ← Housekeeping, backup management
    claude-runner.js     ← Claude CLI spawning (.bat on Windows, .sh on Unix)

  sso/
    index.js             ← Middleware exports: requireAuth, requireAdmin, optionalAuth
    jwt.js               ← HS256 token generation/verification
    users.js             ← Argon2id password hashing, user management
    session-store.js     ← In-memory sessions (10K cap, LRU eviction)
    views/login.html     ← Login page
```

## Database Schema

SQLite with WAL mode for concurrent read/write. 8 tables:

| Table | Purpose |
|-------|---------|
| `cards` | Kanban cards — all columns, status, spec, labels, dependencies, phase durations |
| `sessions` | JWT sessions (10K max, oldest eviction) |
| `audit_log` | Every state change — moves, approvals, rejections, deletes |
| `claude_usage` | CLI invocation tracking (type, card, timestamp) |
| `config` | Runtime key/value store (ports, paths, custom prompts) |
| `error_log` | Persisted errors (level, source, card, context, resolution) |
| `learnings` | Intelligence patterns (category, key, value, confidence) |
| `checkpoints` | Rollback points for intelligence auto-changes |

Every table has `created_at`. Cards have `updated_at` and `deleted_at` (soft delete).

## Frontend

Four files in `public/`, served as static assets:

- `index.html` — Board shell, 7 modals, zero inline scripts
- `app.js` — All client logic: SSE, drag-drop, modals, pipeline rendering
- `style.css` — Anthropic-branded theme with dark mode, responsive from 375px to 4K
- `control-panel.html` — Standalone admin dashboard (no shared code with board)

All DOM manipulation uses the `el()` helper — zero `innerHTML` anywhere. This is enforced by a pre-commit security hook.

## Key Design Decisions

**Why SQLite?** — Single-file database, zero ops, WAL mode handles concurrent reads. This is a local dev tool, not a distributed system. SQLite is the right choice.

**Why vanilla JS?** — No build step means `git clone && pnpm start` works instantly. No webpack, no Vite, no React. The frontend is 77KB of plain JavaScript.

**Why two servers?** — The admin panel has sensitive operations (factory reset, config changes, error logs). Binding to `127.0.0.1` makes it physically unreachable from the network — no firewall rules needed, no auth bypass possible.

**Why .bat wrappers?** — Windows doesn't support Unix pipes for process management. The `.bat` scripts write the Claude prompt to a temp file and pipe it via `type`, eliminating all shell metacharacter injection vectors.
