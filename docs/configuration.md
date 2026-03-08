# Configuration

## Environment Variables

Copy `.env.example` to `.env` before first start. All settings have sensible defaults except passwords.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `51777` | Public server port |
| `ADMIN_PORT` | *random* | Admin server port. Randomized (49152-65535) each start if unset. Pin for stable URL. |
| `ADMIN_PATH` | *random* | Admin panel URL path. 52-char random hex each start if unset. |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | `admin` | Admin login. **Change in production** — loud warning on startup if default. |
| `USER_PASSWORD` | `user` | User login. **Change in production.** |

### Project

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECTS_ROOT` | `~/Projects` | Root folder for the project picker dropdown. |
| `KANBAN_MODE` | `global` | `global` = multi-project board. `single-project` = locked to one folder, autonomous discovery. |
| `SINGLE_PROJECT_PATH` | *parent dir* | Project folder for single-project mode. Defaults to parent of the kanban install directory. |

### Pipeline

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENT_BUILDS` | `1` | Maximum simultaneous Claude Code sessions. |
| `BUILD_TIMEOUT_MINS` | `60` | Hard timeout for any build phase. |
| `IDLE_TIMEOUT_MINS` | `15` | No-log-activity timeout. Kills stalled builds. |
| `AUTO_PROMOTE_BRAINSTORM` | `true` | Auto-decompose brainstorm cards into todo tasks. |
| `MAX_BRAINSTORM_QUEUE` | `3` | Max concurrent brainstorm cards (single-project mode). |
| `DISCOVERY_INTERVAL_MINS` | `30` | Auto-discovery scan interval (single-project mode, 0 = disabled). |
| `MAX_CHILD_CARDS` | `10` | Max child cards per brainstorm initiative. |

### Usage Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `USAGE_PAUSE_PCT` | `80` | Auto-pause pipeline when Claude Max usage exceeds this %. |
| `MAX_HOURLY_SESSIONS` | `0` | Board-level hourly session limit (0 = unlimited). |
| `MAX_WEEKLY_SESSIONS` | `0` | Board-level weekly session limit (0 = unlimited). |

### Operations

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_RETENTION_DAYS` | `7` | How long daily backups are kept. |
| `WEBHOOK_URL` | — | Outbound webhook URL for card state changes (Slack, etc). SSRF-protected. |

## Runtime Config (Control Panel)

Everything above is also editable live from the control panel (gear icon → admin server). Changes take effect immediately without restart and are stored in the database `config` table.

Additional settings available only from the control panel:

- **Claude Model** — Which model to use (default: `claude-opus-4-6`)
- **Claude Effort** — Effort level: `low`, `medium`, `high` (default: `high`)
- **Max Done Visible** — Cards shown in Done column (default: 10)
- **Max Archive Visible** — Cards shown in Archive modal (default: 50)
- **Max Fix Attempts** — Self-healing fix attempts per error (default: 2)
- **Max Review Fix Attempts** — Auto-fix cycles before human escalation (default: 3)

## Custom Prompts

From the control panel, you can inject custom instructions into any phase:

- **Brainstorm Instructions** — Added to the brainstorm prompt. Guide how specs are generated.
- **Build Instructions** — Added to the build prompt. Coding standards, patterns, constraints.
- **Review Criteria** — Added to the review prompt. What to check, what to ignore.
- **Quality Gates** — Conditions that must pass for auto-approval.

Stored in `.data/custom-prompts.json` and the database `config` table.

## Project-Level Review Config

Place a `.kanban-review.md` file in any project's root to augment the AI review prompt for that specific project. This is additive — it extends the global review criteria, not replaces it.
