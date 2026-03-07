# Security Audit — Claude Kanban Board

**Date**: 2026-03-07
**Auditor**: Claude Opus 4.6
**Scope**: Full codebase (`src/`, `public/`)
**Verdict**: NOT production ready. 28 findings. 6 critical, 5 high, 8 medium, 9 low.

---

## CRITICAL (6) — Exploitable, immediate fix required

### C1. Log-stream path traversal via query parameter

**File**: `src/routes/public.js:276-278`
**Endpoint**: `GET /api/cards/:id/log-stream?type=...`
**Auth**: None (unauthenticated)

`req.query.type` has NO restriction on slashes (unlike `:type` route params). The path is constructed as:
```js
var logFile = path.join(LOGS_DIR, 'card-' + id + '-' + type + '.log');
```

`path.join` resolves `..` components. Attack:
```
GET /api/cards/1/log-stream?type=x/../../../../etc/passwd
```
Result: reads arbitrary files (ending in `.log` suffix, but on Windows with backslash variants this is broader).

**Fix**: Whitelist allowed type values: `['build', 'brainstorm', 'review', 'review-fix', 'fix-1', 'fix-2']`. Reject anything containing `/`, `\`, or `..`.

---

### C2. Log endpoint path traversal on Windows

**File**: `src/routes/public.js:270`
**Endpoint**: `GET /api/cards/:id/log/:type`
**Auth**: None (unauthenticated)

Express route `:type` param can't contain `/` but Express decodes `%5C` to `\`. On Windows, `\` is a path separator:
```
GET /api/cards/1/log/..%5C..%5C..%5Cwindows%5Csystem.ini
```
`path.join(LOGS_DIR, 'card-1-..\\..\\..\\windows\\system.ini.log')` traverses up.

**Fix**: Same as C1 — whitelist allowed type values. Also validate that resolved path starts with `LOGS_DIR`.

---

### C3. Command injection via project_path

**File**: `src/services/support.js:87-125`
**Endpoints**: `POST /api/cards/:id/open-vscode`, `open-terminal`, `open-claude`, `preview`
**Auth**: Required (but any authenticated user)

`assign-folder` (`POST /api/cards/:id/assign-folder`) stores ANY string as `project_path` with zero validation. Later used in `spawn()` with `shell: true`:
```js
spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + p + '"'], { shell: true })
```

Payload: setting project_path to `" & calc & "` executes arbitrary commands.

Same vector exists in `openTerminal()`, `openClaude()`, and `previewProject()`.

**Fix**:
1. Validate `project_path` in `assign-folder`: must be absolute path, must exist or be under `PROJECTS_ROOT`, must not contain shell metacharacters (`"`, `&`, `|`, `;`, `` ` ``, `$`, `%`).
2. Use `spawn()` WITHOUT `shell: true` where possible.
3. Validate resolved path starts with `PROJECTS_ROOT`.

---

### C4. Command injection via preview run_command

**File**: `src/services/support.js:232-238`
**Endpoint**: `POST /api/cards/:id/preview`
**Auth**: Required

`runCommand` is read from `.task-complete` (written by Claude CLI — could be manipulated) or `package.json` scripts. Injected directly into shell string:
```js
var fullCmd = 'pnpm install && ' + runCommand;
spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + projectPath + '" && ' + fullCmd], { shell: true })
```

A malicious `.task-complete` with `{"run_command": "pnpm start; rm -rf /"}` executes destructive commands.

**Fix**: Whitelist allowed run commands (`pnpm dev`, `pnpm start`, `pnpm preview`, `node ...`). Or use `spawn()` without `shell: true`, passing arguments as array.

---

### C5. Edit-file path traversal bypass via malicious project_path

**File**: `src/routes/public.js:546-549`
**Endpoint**: `POST /api/cards/:id/edit-file`
**Auth**: Required

Path check:
```js
var fullPath = path.resolve(card.project_path, filePath);
if (!fullPath.startsWith(card.project_path + path.sep) && fullPath !== card.project_path) {
  return res.status(403).json({ error: 'Path traversal not allowed' });
}
```

If attacker sets `project_path` to `/` (Linux) or `C:\` (Windows) via `assign-folder`, the check becomes `startsWith('/')` — always true on Linux. Every file on the system becomes writable.

**Fix**: Validate `project_path` must be under `PROJECTS_ROOT` (see C3 fix). Additionally, resolve both paths and verify containment.

---

### C6. Windows .bat prompt injection

**File**: `src/services/claude-runner.js:15-16`
**Context**: Orchestrator spawning Claude CLI

Prompt escaping for Windows `.bat` files only replaces `"` with `'`:
```js
var escapedPrompt = opts.prompt.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
lines.push(cliBase + ' -p "' + escapedPrompt + '" > ...');
```

Does NOT handle:
- `&` — command chaining (`& calc &`)
- `|` — pipe (`| calc`)
- `%` — variable expansion (`%USERNAME%`, `%COMSPEC%`)
- `^` — escape character in batch

Card spec containing these metacharacters executes arbitrary commands when the `.bat` file runs.

Bash escaping (Linux) is correct — uses `'\''` pattern.

**Fix**: On Windows, escape ALL batch metacharacters (`&`, `|`, `%`, `^`, `<`, `>`, `!`). Or better: write prompt to a temp file and pass `--file` flag instead of inline `-p`.

---

## HIGH (5) — Significant risk, fix before any network exposure

### H1. All read endpoints unauthenticated

**File**: `src/routes/public.js:227-273`
**Impact**: Full data exposure to anonymous users

Unauthenticated endpoints:
- `GET /api/cards` — all cards with titles, descriptions, specs, project paths
- `GET /api/export` — FULL dump: all cards + all sessions + full audit log
- `GET /api/cards/:id/diff` — source code diffs (file contents!)
- `GET /api/cards/:id/log/:type` — build logs containing prompts, code, errors
- `GET /api/cards/:id/review` — review findings
- `GET /api/cards/:id/sessions` — all CLI sessions
- `GET /api/metrics` — project names, paths, scores
- `GET /api/search?q=` — search all card content
- `GET /api/config` — server configuration (ports, paths, model, webhook URL)

**Fix**: Add `requireAuth` to all read endpoints except SSE and auth routes. For "guest view" mode, create a separate read-only subset that strips sensitive fields (project paths, specs, logs).

---

### H2. SSE broadcasts to unauthenticated clients

**File**: `src/routes/public.js:28-37`
**Impact**: Real-time data leak to any connected client

SSE endpoint has NO auth:
```js
router.get('/api/events', function(req, res) {
  // No auth check!
  sseClients.add(res);
```

Broadcasts include card data (titles, descriptions, project paths), toast messages, pipeline state, queue info, config changes. Any anonymous listener sees everything in real-time.

**Fix**: Either require auth on SSE, or create two broadcast channels — public (sanitized events like card count changes) and authenticated (full data).

---

### H3. No ADMIN_PIN = fully open by default

**File**: `src/config.js:73`
**Impact**: All write endpoints accessible to any network client

```js
ADMIN_PIN: process.env.ADMIN_PIN || '',
```

Empty `ADMIN_PIN` makes `PinAuthProvider.isRequired` return `false`. `createSessionHandler` auto-creates admin sessions without login. Every write endpoint becomes accessible to anyone on the network.

**Fix**:
1. Log a prominent warning at startup if `ADMIN_PIN` is empty.
2. When listening on `0.0.0.0` (not just localhost), REQUIRE `ADMIN_PIN` to be set or refuse to start.
3. Generate a random PIN on first run if none is set, print it once.

---

### H4. Constant-time PIN comparison leaks length

**File**: `src/middleware/auth.js:39`

```js
if (credentials.pin && credentials.pin.length === this.pin.length) {
```

The length check is NOT constant-time. Timing side-channel reveals PIN length (4 digits vs 8 characters). The manual charCode loop can also be JIT-optimized to short-circuit.

**Fix**: Use `crypto.timingSafeEqual` with fixed-size buffers:
```js
var a = Buffer.alloc(256); a.write(credentials.pin || '');
var b = Buffer.alloc(256); b.write(this.pin);
if (!crypto.timingSafeEqual(a, b)) return { authenticated: false };
```

---

### H5. Session store unbounded — OOM DoS

**File**: `src/lib/session.js:19`

`var store = new Map()` has no size cap. With no `ADMIN_PIN`, `GET /api/auth/session` auto-creates sessions for every request. Rate limiter allows 30 req/s sustained. Over 24 hours: ~2.6M sessions, 1GB+ RAM growth.

Cleanup runs every hour but only removes sessions older than 24h — new ones accumulate faster than cleanup.

**Fix**: Cap session store at 10,000 entries. Evict oldest on overflow. Add session creation rate limiting separate from general API rate limiting.

---

## MEDIUM (8)

### M1. No CSP header

**File**: `src/middleware/security.js`

No `Content-Security-Policy` header. If any XSS vector is introduced (even by future code changes), no defense-in-depth. Enterprise requires CSP.

**Fix**: Add `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`.

---

### M2. No HSTS header

**File**: `src/middleware/security.js`

No `Strict-Transport-Security`. SSL stripping attacks possible when deployed behind HTTPS proxy.

**Fix**: Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` when behind HTTPS (detect via `X-Forwarded-Proto` or config flag).

---

### M3. Cookie missing Secure flag

**File**: `src/lib/session.js:94`

```js
res.setHeader('Set-Cookie', COOKIE_NAME + '=' + sessionId + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + MAX_AGE_S);
```

No `Secure` flag. Cookie sent over HTTP too. Behind Cloudflare HTTPS, cookie leaks on initial HTTP request before redirect.

**Fix**: Add `Secure` flag when behind HTTPS proxy. Make configurable via env var (`SECURE_COOKIES=true`).

---

### M4. Origin check bypassed by no-Origin requests

**File**: `src/middleware/security.js:31`

```js
var origin = req.headers.origin;
if (!origin) return next();
```

Requests without `Origin` header pass through. Non-browser tools (curl, Postman, scripts) bypass CSRF protection entirely. Combined with stolen session cookie, allows full API manipulation.

**Fix**: For state-changing requests, require either valid `Origin` OR a custom header (e.g., `X-Requested-With: XMLHttpRequest`) that browsers won't send cross-origin without CORS preflight.

---

### M5. Webhook SSRF

**File**: `src/lib/helpers.js:27-42`

`webhookUrl` is configurable via `PUT /api/config`. An authenticated admin can set it to internal service URLs:
```
PUT /api/config { "webhookUrl": "http://169.254.169.254/latest/meta-data/" }
```

Server issues HTTP requests to cloud metadata endpoints (SSRF).

**Fix**: Validate webhook URL against allowlist of domains/IP ranges. Block RFC1918, link-local, and localhost addresses.

---

### M6. No SQLite busy_timeout

**File**: `src/db/index.js:61`

```js
db.pragma('journal_mode = WAL');
```

No `busy_timeout` set. Under concurrent write access, SQLite throws `SQLITE_BUSY` immediately instead of retrying. Causes random 500 errors under load.

**Fix**: Add `db.pragma('busy_timeout = 5000')` after WAL mode.

---

### M7. No input length validation

**File**: `src/routes/public.js:354-363`

Card title, description, spec have no max length validation. 1MB body limit allows 1MB card descriptions, all returned on every `GET /api/cards` call. 50 such cards = 50MB per board fetch.

**Fix**: Validate max lengths: title 500 chars, description 10K chars, spec 100K chars. Reject with 400.

---

### M8. Admin rate limit shares IP with all localhost

**File**: `src/lib/session.js:105-114`

Admin server binds `127.0.0.1`. ALL requests share source IP. 10 failed login attempts from ANY local process (including a compromised Claude CLI session) permanently locks out the admin panel for everyone.

**Fix**: Use a separate rate limit store for admin auth, or key admin rate limiting on a different signal (e.g., session fingerprint + IP instead of just IP).

---

## LOW (9)

### L1. Test endpoint has no auth

**File**: `src/routes/public.js:659-667`

Gated by `NODE_ENV === 'test'` but has NO auth. If accidentally deployed with `NODE_ENV=test`, full card state manipulation by anyone.

**Fix**: Add `requireAuth` even in test mode. Or use a separate test server.

---

### L2. No graceful shutdown

**File**: `src/server.js:193-196`

`SIGTERM` handler just removes PID file and exits. No draining in-flight requests, no closing database connection, no stopping active builds. SQLite WAL could corrupt. Orphaned Claude CLI processes left running.

**Fix**: Implement graceful shutdown: stop accepting new connections, wait for in-flight requests (5s timeout), close DB, kill active builds, then exit.

---

### L3. Cache-Control: no-store on all responses

**File**: `src/middleware/security.js:10`

`Cache-Control: no-store` applied to ALL responses including static assets (JS, CSS, images). Every page load re-downloads everything. Wastes bandwidth under heavy traffic.

**Fix**: Apply `no-store` only to API responses. Set `Cache-Control: public, max-age=86400, immutable` on static assets.

---

### L4. Fingerprint is IP+UA only

**File**: `src/lib/session.js:31-34`

Attacker on same network (VPN, corporate) with spoofed User-Agent matches fingerprint perfectly. Stolen cookie works.

**Fix**: Accept as defense-in-depth limitation. Document that session binding is best-effort, not absolute. Consider adding Accept-Language, Accept-Encoding to fingerprint hash.

---

### L5. Console logging throughout

**Files**: Multiple `console.log` and `console.error` calls across all services.

No structured logging, no log levels, no redaction of sensitive data. Card titles, project paths, error details leak to stdout.

**Fix**: Replace with structured logger (pino). Redact sensitive fields. Use log levels.

---

### L6. process.exit(0) in factory reset

**File**: `src/routes/admin.js:149`

Abrupt `process.exit(0)` after 500ms timeout. No cleanup, no graceful shutdown.

**Fix**: Use graceful shutdown sequence (see L2).

---

### L7. Backup db.backup() promise not awaited

**File**: `src/db/index.js:172`

```js
db.backup(hotBackupPath()).catch(function() {});
```

Backup failures are silently swallowed. No logging, no alerting.

**Fix**: Log backup failures. Track last successful backup time. Alert if no successful backup in 30 minutes.

---

### L8. Content-Type not validated on POST/PUT

**Files**: All route handlers.

Endpoints accept any Content-Type. Express `json()` middleware parses JSON regardless, but no explicit validation. Unusual Content-Types could bypass WAF rules.

**Fix**: Add middleware to reject non-`application/json` Content-Type on API endpoints.

---

### L9. In-memory session store lost on restart

**File**: `src/lib/session.js`

Server restart = all sessions destroyed = all users logged out. No persistence.

**Fix**: For enterprise, persist sessions to SQLite. For current scope, accept as limitation and document.

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
- Origin validation on state-changing requests
- SameSite=Strict cookies
