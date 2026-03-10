# Configuration

## Environment Variables

Copy `.env.example` to `.env` before first start. All settings have sensible defaults except passwords.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `51777` | Public server port |
| `ADMIN_PORT` | *random* | Admin server port. Randomized (49152-65535) each start if unset. Pin for stable URL. |
| `ADMIN_PATH` | *random* | Admin panel URL path. 52-char random hex each start if unset. |
| `ENABLE_HSTS` | `false` | Force HSTS header even without X-Forwarded-Proto. Set `true` when behind HTTPS proxy. |
| `SECURE_COOKIES` | `false` | Set cookie `Secure` flag. Auto-enabled when `NODE_ENV=production`. |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | `admin` | Admin login. **Change in production**, loud warning on startup if default. |
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

### Claude

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_MODEL` | `claude-opus-4-6` | Model for brainstorm, build, review sessions. |
| `CLAUDE_EFFORT` | `high` | Effort level: `low`, `medium`, `high`. |

### Spec Intelligence

| Variable | Default | Description |
|----------|---------|-------------|
| `MULTI_LENS_BRAINSTORM` | `true` | Force multi-perspective analysis (user, adversary, maintainer) before spec writing. |
| `CREATIVE_CONSTRAINT_PCT` | `20` | Percentage of brainstorms that receive a creative thinking constraint (0-100). |
| `SPEC_FEEDBACK_LOOP` | `true` | Score spec effectiveness and learn patterns over time. |
| `CONFRONTATIONAL_PCT` | `70` | Percentage of brainstorms that receive confrontational spec challenges (0-100). |
| `SPEC_APPROVAL_GATE` | `false` | If `true`, brainstorm outputs go to `spec-ready` status for human approval before decomposition. |

### Usage Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `USAGE_PAUSE_PCT` | `80` | Auto-pause pipeline when Claude Max usage exceeds this %. |
| `MAX_HOURLY_SESSIONS` | `0` | Board-level hourly session limit (0 = unlimited). |
| `MAX_WEEKLY_SESSIONS` | `0` | Board-level weekly session limit (0 = unlimited). |
| `USAGE_CACHE_TTL_MINS` | `55` | How long to cache usage data before re-fetching from Anthropic API. |
| `MAX_RECOVERY_WAIT_HOURS` | `6` | Max hours to wait for usage recovery before giving up. |
| `RECOVERY_FALLBACK_MINS` | `30` | Fallback poll interval when recovery estimate unavailable. |
| `MAX_RECOVERY_POLLS_PER_HOUR` | `2` | Max usage API polls per hour during recovery. |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_GENERAL_BURST` | `200` | Token bucket burst size for general API requests. |
| `RATE_LIMIT_GENERAL_REFILL` | `100` | Tokens refilled per second for general API. |
| `RATE_LIMIT_AUTH_BURST` | `5` | Token bucket burst for auth endpoints. |
| `RATE_LIMIT_AUTH_REFILL` | `1` | Tokens refilled per second for auth. |
| `SSE_MAX_PER_IP` | `5` | Max SSE connections per IP. |
| `SSE_MAX_TOTAL` | `200` | Global max SSE connections. |

### Sessions

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_MAX_AGE_MINS` | `1440` | Session TTL in minutes (default: 24h). |
| `MAX_SESSIONS` | `10000` | Max in-memory sessions before LRU eviction. |
| `JWT_TTL_MINS` | `1440` | JWT token TTL in minutes. |

### Data Retention

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_RETENTION_DAYS` | `7` | How long per-card logs are kept. |
| `SNAPSHOT_ARCHIVE_RETENTION_DAYS` | `14` | How long archived snapshots are kept. |
| `MAX_AUDIT_ROWS` | `10000` | Max rows in audit_log before pruning. |
| `MAX_ARCHIVED` | `50` | Max archived cards before oldest are soft-deleted. |
| `RUNTIME_STALE_HOURS` | `24` | Clean up generated .bat/.sh scripts older than this. |

### Polling and Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | `5000` | Brainstorm/build completion polling interval. |
| `BRAINSTORM_TIMEOUT_MINS` | `30` | Hard timeout for brainstorm phase. |
| `DECOMPOSE_TIMEOUT_MINS` | `15` | Hard timeout for spec decomposition. |
| `SELF_HEAL_TIMEOUT_MINS` | `10` | Hard timeout for self-healing fix attempts. |
| `DISCOVERY_TIMEOUT_MINS` | `30` | Hard timeout for auto-discovery scans. |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Heartbeat file write interval for watchdog. |
| `RATE_LIMIT_MIN_POLLS` | `6` | Minimum polling retries during rate-limit recovery. |

### Intelligence Thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_LABEL_CONFIDENCE` | `40` | Minimum confidence (0-100) for auto-label suggestions. |
| `LABEL_SCORE_THRESHOLD` | `60` | Minimum score (0-100) for a label suggestion to be applied. |
| `MAX_AUTO_LABELS` | `3` | Max labels auto-applied per card. |

### Card and Snapshot Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_TOTAL_CARDS` | `500` | Maximum total cards in the database. |
| `SNAPSHOT_MAX_FILE_SIZE_MB` | `10` | Max file size to include in pre-work snapshots. |

### Server Intervals

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_SCAN_INTERVAL_SECS` | `30` | DB error scanner run interval. |
| `ANALYSIS_INTERVAL_MINS` | `30` | Intelligence analysis cycle interval. |
| `HOUSEKEEPING_INTERVAL_MINS` | `60` | Housekeeping (cleanup, backups) interval. |

### Error Handling

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_UNCAUGHT_BEFORE_EXIT` | `10` | Uncaught exceptions tolerated before forced exit. Counter resets every 5 min. |

### Operations

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_URL` | -- | Outbound webhook URL for card state changes (Slack, etc). SSRF-protected. |

### Secret Vault (Cloudflare Worker)

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_BROKER_URL` | -- | Cloudflare Worker vault URL. 10-layer defense in depth. |
| `SECRET_BROKER_CLIENT_ID` | -- | Client ID from vault `/setup` UI. |
| `SECRET_BROKER_HMAC_KEY` | -- | HMAC-SHA256 request signing key. |
| `SECRET_BROKER_ENC_KEY` | -- | 32-byte hex key for AES-256-GCM request/response encryption. |
| `SECRET_BROKER_DERIVE_KEY` | -- | 32-byte hex half-B for HKDF key derivation (vault stores half-A). |

## Runtime Config (Control Panel)

Everything above is also editable live from the control panel (admin server). Changes take effect immediately without restart and are stored in the database `config` table.

Additional settings available only from the control panel:

- **Max Done Visible** -- Cards shown in Done column (default: 10)
- **Max Archive Visible** -- Cards shown in Archive modal (default: 50)
- **Max Fix Attempts** -- Self-healing fix attempts per error (default: 2)
- **Max Review Fix Attempts** -- Auto-fix cycles before human escalation (default: 3)

## Custom Prompts

From the control panel, you can inject custom instructions into any phase:

- **Brainstorm Instructions** -- Added to the brainstorm prompt. Guide how specs are generated.
- **Build Instructions** -- Added to the build prompt. Coding standards, patterns, constraints.
- **Review Criteria** -- Added to the review prompt. What to check, what to ignore.
- **Quality Gates** -- Conditions that must pass for auto-approval.

Stored in `.data/custom-prompts.json` and the database `config` table.

## Project-Level Review Config

Place a `.kanban-review.md` file in any project's root to augment the AI review prompt for that specific project. This is additive; it extends the global review criteria, not replaces it.
