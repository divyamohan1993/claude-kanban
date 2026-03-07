# Security Audit Log

Running log of security audits, findings, and remediations.

---

## Audit #1 — 2026-03-07

**Auditor**: Claude Opus 4.6 | **Scope**: `src/`, `public/` | **Findings**: 28 (6C, 5H, 8M, 9L)
**Remediation**: 2026-03-07 | **Result**: 26 fixed, 2 deferred

### Critical — 6/6 fixed

| ID | Finding | Status | Fix |
|----|---------|--------|-----|
| C1 | Log-stream path traversal (`?type=../../etc/passwd`) | FIXED | Whitelist `ALLOWED_LOG_TYPES`, verify resolved path under `LOGS_DIR`, require auth |
| C2 | Log endpoint Windows `%5C` traversal | FIXED | Same whitelist + path check as C1, require auth |
| C3 | Command injection via `project_path` in spawn() | FIXED | `validateProjectPath()` — absolute, under `PROJECTS_ROOT`, no shell metacharacters; enforced at assign-folder + every spawn site |
| C4 | Command injection via preview `run_command` | FIXED | `isAllowedRunCommand()` — must start with pnpm/npm/node, no metacharacters |
| C5 | Edit-file traversal via `project_path=/` | FIXED | Validate project_path under `PROJECTS_ROOT` before writes, resolve both paths |
| C6 | Windows .bat prompt injection (`%`, `&`, `^`) | FIXED | Prompt written to temp file, piped via `type file \| claude` — zero inline content |

### High — 5/5 fixed

| ID | Finding | Status | Fix |
|----|---------|--------|-----|
| H1 | All read endpoints unauthenticated | FIXED | `requireAuth` on every GET API endpoint |
| H2 | SSE broadcasts to anonymous clients | FIXED | `requireAuth` on `/api/events` |
| H3 | No ADMIN_PIN = fully open | FIXED | Auto-generate 6-digit PIN, save to `.data/.generated-pin`, print at startup |
| H4 | PIN timing attack (length leak + JIT) | FIXED | `crypto.timingSafeEqual` with fixed 256-byte buffers |
| H5 | Session store unbounded (OOM) | FIXED | Cap at 10,000, evict oldest on overflow |

### Medium — 8/8 fixed

| ID | Finding | Status | Fix |
|----|---------|--------|-----|
| M1 | No CSP header | FIXED | `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'` |
| M2 | No HSTS header | FIXED | `Strict-Transport-Security` when `X-Forwarded-Proto: https` or `ENABLE_HSTS=true` |
| M3 | Cookie missing `Secure` flag | FIXED | Added when `SECURE_COOKIES=true` or `NODE_ENV=production` |
| M4 | Origin check bypassed (no-Origin requests) | FIXED | Require `X-Requested-With: XMLHttpRequest` on POST/PUT/DELETE without Origin; frontend updated |
| M5 | Webhook SSRF to internal IPs | FIXED | Block RFC1918, link-local, loopback in `isBlockedWebhookUrl()`; enforced on send + config set |
| M6 | No SQLite busy_timeout | FIXED | `busy_timeout = 5000` pragma |
| M7 | No input length validation | FIXED | Title 500, description 10K, spec 100K chars |
| M8 | Admin rate limit shared localhost IP | FIXED | Rate limit keyed on IP + User-Agent |

### Low — 7/9 fixed, 2 deferred

| ID | Finding | Status | Fix |
|----|---------|--------|-----|
| L1 | Test endpoint no auth | FIXED | `requireAuth` on test state endpoint |
| L2 | No graceful shutdown | FIXED | Drain connections, close DB, kill builds, 5s timeout |
| L3 | `no-store` on static assets | FIXED | `no-store` for API only; `max-age=86400, immutable` for static |
| L4 | Fingerprint IP+UA only | FIXED | Added Accept-Language + Accept-Encoding to hash |
| L5 | Console logging (no structured/pino) | DEFERRED | Architectural — no credentials in stdout, admin-only visibility |
| L6 | `process.exit(0)` in factory reset | FIXED | Uses SIGTERM to trigger graceful shutdown |
| L7 | Backup failures silently swallowed | FIXED | Log errors, track last success, alert at 30min |
| L8 | No Content-Type validation on POST/PUT | FIXED | `requireJsonContentType` middleware, 415 on non-JSON |
| L9 | In-memory sessions lost on restart | DEFERRED | Accepted per audit — single-user dev tool, re-login acceptable |

### Verified solid (no action needed)

Rate limiter, SSE caps, slowloris protection, body limits, prepared statements, backup path traversal protection, soft delete + audit trail, session rotation, zero innerHTML, server-computed actions/display, clean dependencies, two-server architecture, SameSite=Strict cookies.
