# Security Audit — Claude Kanban Board

**Date**: 2026-03-07
**Auditor**: Claude Opus 4.6
**Scope**: Full codebase (`src/`, `public/`)
**Original Verdict**: NOT production ready. 28 findings. 6 critical, 5 high, 8 medium, 9 low.

**Remediation Date**: 2026-03-07
**Remediated by**: Claude Opus 4.6
**Status**: 26 of 28 findings FIXED. 2 deferred (L5, L9 — non-exploitable, architectural).

---

## CRITICAL (6) — Exploitable, immediate fix required

### C1. Log-stream path traversal via query parameter — FIXED

**File**: `src/routes/public.js`
**Endpoint**: `GET /api/cards/:id/log-stream?type=...`

`req.query.type` had NO restriction on slashes. `path.join` resolves `..` components, allowing arbitrary file reads.

**Fix applied**: Whitelist `ALLOWED_LOG_TYPES` (`build`, `brainstorm`, `review`, `review-fix`, `fix-1`, `fix-2`, `fix-3`). Reject any type not in the list. Verify resolved path starts with `LOGS_DIR`. Endpoint also now requires authentication.

---

### C2. Log endpoint path traversal on Windows — FIXED

**File**: `src/routes/public.js`
**Endpoint**: `GET /api/cards/:id/log/:type`

Express decodes `%5C` to `\`, which is a Windows path separator — allows traversal.

**Fix applied**: Same whitelist + resolved path check as C1. Endpoint now requires authentication.

---

### C3. Command injection via project_path — FIXED

**File**: `src/services/support.js`, `src/routes/public.js`
**Endpoints**: `POST /api/cards/:id/open-vscode`, `open-terminal`, `open-claude`, `preview`, `assign-folder`

`assign-folder` stored ANY string as `project_path` with zero validation, later used in `spawn()`.

**Fix applied**:
1. `validateProjectPath()` in `support.js` — must be absolute, no shell metacharacters (`;&|$%^<>!(){}[]"'#~`), must resolve under `PROJECTS_ROOT`.
2. Validation enforced at `assign-folder` endpoint (rejects invalid paths with 400).
3. Every `spawn()` site (`openInVSCode`, `openTerminal`, `openClaude`, `previewProject`) validates path before use.
4. `assign-folder` stores `path.resolve()` result (normalized).

---

### C4. Command injection via preview run_command — FIXED

**File**: `src/services/support.js`
**Endpoint**: `POST /api/cards/:id/preview`

`runCommand` from `.task-complete` or `package.json` was injected directly into shell strings.

**Fix applied**: `isAllowedRunCommand()` — must start with `pnpm`, `npm`, or `node`, must not contain shell metacharacters (`;&|$<>!`). Rejects with descriptive error.

---

### C5. Edit-file path traversal bypass via malicious project_path — FIXED

**File**: `src/routes/public.js`
**Endpoint**: `POST /api/cards/:id/edit-file`

If `project_path` was set to `/` or `C:\`, the containment check became trivially true.

**Fix applied**:
1. Validate `project_path` is under `PROJECTS_ROOT` using `isPathUnderProjectsRoot()`.
2. Use `path.resolve()` on both project path and file path for containment check.
3. Combined with C3 fix, `project_path` can no longer be set to root-level paths.

---

### C6. Windows .bat prompt injection — FIXED

**File**: `src/services/claude-runner.js`
**Context**: Orchestrator spawning Claude CLI

Prompt escaping only replaced `"` with `'`, missing `%`, `^`, `&`, `|`, `<`, `>`, `!`.

**Fix applied**: Eliminated the attack surface entirely. Prompt written to temp `.txt` file (`RUNTIME_DIR/.prompt-{id}.txt`), piped via `type "file" | claude ...` in the `.bat` script. No prompt content ever appears in the batch command line.

---

## HIGH (5) — Significant risk, fix before any network exposure

### H1. All read endpoints unauthenticated — FIXED

**File**: `src/routes/public.js`
**Impact**: Full data exposure to anonymous users

All GET API endpoints were accessible without authentication.

**Fix applied**: Added `requireAuth` middleware to every read endpoint: `/api/cards`, `/api/queue`, `/api/activities`, `/api/pipeline`, `/api/search`, `/api/metrics`, `/api/export`, `/api/archive`, `/api/cards/:id/review`, `/api/cards/:id/sessions`, `/api/cards/:id/has-snapshot`, `/api/cards/:id/diff`, `/api/cards/:id/log/:type`, `/api/cards/:id/log-stream`, `/api/config`.

Auth routes (`/api/auth/session`, `/api/auth/login`, `/api/auth/logout`) and static files remain unauthenticated.

---

### H2. SSE broadcasts to unauthenticated clients — FIXED

**File**: `src/routes/public.js`
**Impact**: Real-time data leak to any connected client

**Fix applied**: Added `requireAuth` to the `/api/events` SSE endpoint. Browser's `EventSource` sends cookies automatically for same-origin requests, so authenticated clients work transparently. Unauthenticated connections receive 401.

---

### H3. No ADMIN_PIN = fully open by default — FIXED

**File**: `src/config.js`
**Impact**: All write endpoints accessible to any network client

**Fix applied**:
1. If `ADMIN_PIN` env var is empty, auto-generates a random 6-digit PIN.
2. PIN saved to `.data/.generated-pin` (persists across restarts).
3. PIN printed prominently at startup: `*** ADMIN_PIN not set — auto-generated: XXXXXX ***`.
4. Users can override by setting `ADMIN_PIN` in `.env`.
5. `PinAuthProvider.isRequired` now always returns `true` — login is mandatory.

---

### H4. Constant-time PIN comparison leaks length — FIXED

**File**: `src/middleware/auth.js`

Manual `charCodeAt` loop with length pre-check was vulnerable to timing side-channels.

**Fix applied**: Replaced with `crypto.timingSafeEqual` using fixed-size 256-byte buffers. Both the user input and stored PIN are written into identically-sized buffers before comparison. No length leak, no JIT short-circuiting.

---

### H5. Session store unbounded — OOM DoS — FIXED

**File**: `src/lib/session.js`

`var store = new Map()` had no size cap. Sessions accumulated faster than hourly cleanup.

**Fix applied**: `MAX_SESSIONS = 10000`. On overflow, evicts the oldest session before creating new one. Combined with H3 fix (PIN always required), session flooding now requires valid credentials.

---

## MEDIUM (8)

### M1. No CSP header — FIXED

**File**: `src/middleware/security.js`

**Fix applied**: Added `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`.

---

### M2. No HSTS header — FIXED

**File**: `src/middleware/security.js`

**Fix applied**: Added `Strict-Transport-Security: max-age=31536000; includeSubDomains` when `X-Forwarded-Proto: https` is present or `ENABLE_HSTS=true` env var is set.

---

### M3. Cookie missing Secure flag — FIXED

**File**: `src/lib/session.js`

**Fix applied**: `Secure` flag added to Set-Cookie when `SECURE_COOKIES=true` or `NODE_ENV=production`. Configurable for development (HTTP) vs production (HTTPS behind Cloudflare).

---

### M4. Origin check bypassed by no-Origin requests — FIXED

**Files**: `src/middleware/security.js`, `public/app.js`, `public/control-panel.html`

Requests without `Origin` header bypassed CSRF protection.

**Fix applied**:
1. Server: state-changing requests (POST/PUT/DELETE) without `Origin` must include `X-Requested-With: XMLHttpRequest`. Rejects with 403 otherwise.
2. Frontend: `X-Requested-With: XMLHttpRequest` added to `api()` wrapper and login `fetch()` calls in both `app.js` and `control-panel.html`.
3. Browsers won't send custom headers cross-origin without CORS preflight — blocks CSRF from external sites.

---

### M5. Webhook SSRF — FIXED

**File**: `src/lib/helpers.js`, `src/services/usage.js`

**Fix applied**:
1. `isBlockedWebhookUrl()` blocks RFC1918 (`10.x`, `172.16-31.x`, `192.168.x`), link-local (`169.254.x`), loopback (`127.x`, `localhost`, `::1`), and `0.0.0.0`.
2. `sendWebhook()` checks URL before every request.
3. `setConfig()` in usage service silently rejects SSRF-target URLs when setting `webhookUrl`.

---

### M6. No SQLite busy_timeout — FIXED

**File**: `src/db/index.js`

**Fix applied**: `db.pragma('busy_timeout = 5000')` added after WAL mode. SQLite retries for up to 5 seconds on SQLITE_BUSY instead of immediate failure.

---

### M7. No input length validation — FIXED

**File**: `src/routes/public.js`

**Fix applied**: Length limits enforced on card creation (`POST /api/cards`), update (`PUT /api/cards/:id`), and spec edit (`PUT /api/cards/:id/spec`):
- Title: max 500 characters
- Description: max 10,000 characters
- Spec: max 100,000 characters
Rejects with 400 and descriptive error.

---

### M8. Admin rate limit shares IP with all localhost — FIXED

**File**: `src/lib/session.js`, `src/middleware/auth.js`

All localhost requests shared `127.0.0.1` — one compromised process could lock out all admin access.

**Fix applied**: Rate limit keyed on `IP + User-Agent` via `rateLimitKey()`. Different local processes (browsers, scripts, Claude CLI) have distinct User-Agent strings. `checkRateLimit`, `recordFailedLogin`, and `recordSuccessfulLogin` all accept `req` parameter for fingerprinting.

---

## LOW (9)

### L1. Test endpoint has no auth — FIXED

**File**: `src/routes/public.js`

**Fix applied**: Added `requireAuth` to the test-only `PUT /api/test/cards/:id/state` endpoint.

---

### L2. No graceful shutdown — FIXED

**File**: `src/server.js`

**Fix applied**: `gracefulShutdown()` function handles SIGTERM and SIGINT:
1. Kills all active pipeline builds (`pipeline.killAll()`).
2. Closes public server (stops accepting connections, drains in-flight).
3. Closes admin server.
4. Closes SQLite database (`db.close()`).
5. Removes PID file.
6. Force exits after 5-second timeout if drain takes too long.

---

### L3. Cache-Control: no-store on all responses — FIXED

**File**: `src/middleware/security.js`

**Fix applied**: Conditional Cache-Control:
- API paths (`/api/*`): `Cache-Control: no-store` (sensitive data, never cache)
- Static files: `Cache-Control: public, max-age=86400, immutable` (JS, CSS, images)

---

### L4. Fingerprint is IP+UA only — FIXED

**File**: `src/lib/session.js`

**Fix applied**: Fingerprint hash now includes `Accept-Language` and `Accept-Encoding` headers in addition to IP and User-Agent. Still best-effort defense-in-depth, not absolute.

---

### L5. Console logging throughout — DEFERRED

**Files**: Multiple

**Status**: Not fixed in this pass. Replacing all `console.log`/`console.error` with pino structured logging is an architectural change touching every file. No credentials leak to stdout — only card titles, project paths, and error details visible to the server admin. Will address in a dedicated logging refactor.

---

### L6. process.exit(0) in factory reset — FIXED

**File**: `src/routes/admin.js`

**Fix applied**: Factory reset now sends `SIGTERM` to self (`process.kill(process.pid, 'SIGTERM')`) instead of `process.exit(0)`. This triggers the L2 graceful shutdown handler — builds killed, DB closed, connections drained.

---

### L7. Backup db.backup() promise not awaited — FIXED

**File**: `src/db/index.js`

**Fix applied**:
1. All `db.backup()` `.catch()` handlers now log errors: `console.error('[db] Hot/Hourly/Daily backup failed:', err.message)`.
2. `lastSuccessfulBackup` timestamp tracked — alerts if no successful backup in 30 minutes.
3. Initial backup on load also logs failures.

---

### L8. Content-Type not validated on POST/PUT — FIXED

**File**: `src/middleware/security.js`, `src/server.js`

**Fix applied**: `requireJsonContentType` middleware rejects POST/PUT requests to `/api/*` endpoints with non-`application/json` Content-Type (returns 415 Unsupported Media Type). Exempts auth endpoints and empty-body requests.

---

### L9. In-memory session store lost on restart — DEFERRED

**File**: `src/lib/session.js`

**Status**: Accepted as limitation per audit recommendation. Persisting sessions to SQLite would add complexity for a dev tool. Server restart re-requires PIN login — acceptable for the current single-user use case.

---

## What IS solid (no action needed)

- Token bucket rate limiter — O(1), bounded memory, pre-built responses
- SSE connection caps (5/IP, 200 global)
- Slowloris protection (30s headers, 120s request)
- Body size limits (1MB)
- All DB queries use prepared statements (no SQL injection)
- Backup restore has path traversal protection
- Soft delete with append-only audit trail
- Session rotation on login (prevents fixation)
- Zero `innerHTML` in frontend (DOM-safe `el()` helper)
- Server-computed `card.actions` and `card.display`
- Dependencies clean (`pnpm audit` — 0 vulnerabilities)
- Two-server architecture (admin on 127.0.0.1)
- Origin validation on state-changing requests (now with X-Requested-With fallback)
- SameSite=Strict cookies (now with optional Secure flag)

---

## Summary

| Severity | Total | Fixed | Deferred |
|----------|-------|-------|----------|
| Critical | 6     | 6     | 0        |
| High     | 5     | 5     | 0        |
| Medium   | 8     | 8     | 0        |
| Low      | 9     | 7     | 2        |
| **Total**| **28**| **26**| **2**    |

**Deferred items** (L5: structured logging, L9: persistent sessions) are non-exploitable architectural improvements. Neither enables an attack vector.
