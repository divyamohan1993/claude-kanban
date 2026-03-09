# Changelog

All notable changes to this project will be documented in this file.

## [3.1.0] - 2026-03-09

### Changed
- **WCAG 2.2 AAA compliance**: Full accessibility overhaul of main board, modals, and login page
  - Color contrast: All text meets 7:1 ratio (normal) / 4.5:1 (large) in both light and dark themes
  - Light mode: text-secondary #44403C, text-tertiary #504C47, primary #9A5B0A, success #15572A, error #991B1B
  - Dark mode: text-secondary #C4C0BC, text-tertiary #C1BDB9, primary #F5B73B, success #4ADE80, error #FCA5A5
  - Font sizes: Minimum 12px across entire UI (was 9px in labels, badges, timestamps)
  - Line heights: 1.5+ on all body text for readability
  - Target sizes: All interactive elements meet 44x44px minimum (icon buttons, modal close, idea controls)
  - Focus indicators: 3px outline + box-shadow on all interactive elements via `focus-visible`
  - Skip-to-content link for keyboard navigation bypass
  - Reduced motion: `prefers-reduced-motion` media query on all transitions
- **Focus trapping**: MutationObserver auto-traps focus inside active modals (Tab cycles through focusable elements)
- **Card accessibility**: Cards are keyboard-navigable with `tabindex="0"`, `role="article"`, `aria-label`, Enter key opens detail
- **Toast accessibility**: ARIA `role="status"` and `aria-live="polite"` on toast notifications, 6s display duration
- **Card spacing**: Increased gap between cards (5px to 10px), card padding (10px to 12px/14px), list padding (5px to 8px) for clear visual separation
- **Login page**: AAA-compliant colors, minimum 44px button height, focus-visible styles, reduced motion support
- **Semantic HTML**: Added `role="banner"` on header, `role="main"` on board, `aria-modal="true"` on all 8 modals

## [3.0.0] - 2026-03-09

### Added
- **First-run setup wizard**: `/auth/setup` appears automatically on fresh install
  - 3-step wizard: create super admin account, configure SSO provider, review and confirm
  - Permanently locked after completion (requires reclone/reinstall to access again)
  - Password strength meter with visual feedback
- **Super Admin role**: New top-level role above admin in the hierarchy
  - `superadmin > admin > user` role chain
  - Only one superadmin account allowed (created during setup)
  - Superadmin has exclusive access to user management and SSO configuration
  - Cannot be deleted or disabled via the UI
- **DB-backed user store**: Replaces hardcoded user array with SQLite `users` table
  - AES-256-GCM field-level encryption for sensitive data (email)
  - Master encryption key auto-generated and stored in config table
  - Argon2id password hashing (64MB, 3 iterations, timing-safe rejection)
  - Default users (admin/admin, user/user) seeded on first run
- **User management suite**: Full CRUD for super admins at `/users` on admin server
  - Create, edit, delete users with role assignment
  - Role-based access control: superadmin can assign admin or user roles
  - Enable/disable accounts without deletion
  - Protected superadmin account (cannot be deleted or role-changed)
  - Control panel nav link to user management page
- **SSO configuration**: Choose between built-in auth, OIDC, SAML 2.0, or LDAP
  - OIDC: issuer URL, client ID, client secret, redirect URI
  - SAML: entry point, issuer/entity ID, IdP certificate
  - LDAP: server URL, bind DN, bind password, search base, search filter
  - All secrets encrypted with AES-256-GCM at rest
  - Configuration stored in DB config table
- **User management API**: RESTful endpoints (superadmin-only)
  - `GET /api/users` — list all users
  - `POST /api/users` — create user
  - `PUT /api/users/:id` — update user
  - `DELETE /api/users/:id` — delete user
  - `GET /api/sso-config` — get SSO configuration (redacted secrets)
- **`requireSuperAdmin` middleware**: New SSO middleware for superadmin-only routes
- **Setup redirect middleware**: All routes redirect to `/auth/setup` until first-run setup is complete

### Changed
- **`requireAdmin` middleware**: Now accepts both `admin` and `superadmin` roles
- **Session check**: Returns `userManagement: true` for superadmin sessions, `adminPath` for both admin and superadmin
- **Admin redirect**: Accepts superadmin role in addition to admin

## [2.8.0] - 2026-03-09

### Changed
- **WCAG 2.2 AAA compliance**: Full accessibility overhaul of control panel
  - Color contrast: All text meets 7:1 minimum ratio. Added `-text` variants for all accent colors
  - Font sizes: Minimum 13px across entire UI (was 9px). Body text 14-15px
  - Line height: Base 1.6, descriptions 1.5 for improved readability
  - Focus indicators: Global `focus-visible` ring on all interactive elements
  - Target sizes: All buttons, toggles, nav items meet 44px minimum
  - Skip-to-content link for keyboard navigation
  - Semantic HTML: `<h1>`/`<h2>` headings, `<main>`, `<nav>`, `<p>` elements
  - ARIA: `role="tab/tabpanel"`, `aria-selected`, `aria-controls`, `aria-labelledby`, `aria-expanded`, `role="switch"` with `aria-checked`, `role="progressbar"` on usage bars, `aria-live` regions, `aria-describedby` on config inputs linked to help text
  - Toggle switches: Larger (44x24px), `role="switch"`, keyboard-focusable with visible ring
  - Toasts: `role="alert"`, container `aria-live="assertive"`
  - Reduced motion: Already supported via `prefers-reduced-motion`
- **Interactive backup timeline**: Replaces static dot timeline with zoomable, pannable explorer
  - Mouse wheel zoom centered on cursor position (min 3 minutes, max full range)
  - Click-and-drag panning when zoomed in
  - Touch support: single-finger pan, pinch-to-zoom
  - Keyboard: +/- zoom, arrow keys pan, 0/Home resets
  - Minimap bar showing full range with viewport indicator, click to jump
  - Adaptive time labels (days/hours/minutes) based on zoom level
  - Zoom level display with range indicator
  - Click any dot to select and show detail panel with restore button

## [2.7.0] - 2026-03-09

### Changed
- **Control panel redesign**: Replaced accordion-based layout with enterprise sidebar + tab navigation. All 7 sections (Overview, Pipeline, Configuration, Custom Prompts, Usage, Backups, System) visible in fixed sidebar at all times. Anthropic Claude theme, system fonts only for fastest render on old hardware
- **Full runtime configurability**: Extracted ~55 hardcoded constants from 12 service files into `runtime` config object. All parameters now live-configurable via admin control panel without server restart
- **11 config cards**: Configuration page organized into Mode & Project, Build & Timeouts, Review & Quality, Intelligence & Brainstorm, Rate Limiting, Sessions & Auth, Safety & Limits, Usage Recovery, Retention & Cleanup, Display & Webhooks
- **Service file updates**: Replaced hardcoded values in brainstorm.js, pipeline.js, auto-discover.js, rate-limit.js, session-store.js, sso/index.js, snapshot.js, intelligence.js, public.js, admin.js, server.js with runtime references
- **Rate limiter dynamic config**: Token bucket CONFIG object now uses getters reading from runtime, allowing live rate-limit tuning
- **Session store dynamic config**: Removed hardcoded MAX_AGE_MS and MAX_SESSIONS constants, reads from runtime.sessionMaxAgeMins and runtime.maxSessions
- **getConfig/setConfig expansion**: usage.js now exposes all ~55 runtime fields via API with per-field validation (min/max bounds)

## [2.6.0] - 2026-03-09

### Changed
- **DB indexes**: Added 7 indexes on cards (column_name+deleted_at, status, project_path, parent_card_id, updated_at), sessions (card_id), and claude_usage (started_at). All queries that filter/sort by these columns now use index scans instead of full table scans
- **COUNT queries**: Added `countAll`, `countTotal`, `countByColumn`, `countByStatus`, `auditCount` prepared statements. Replaces `getAll().length` full table loads with O(1) index-backed counts. Used in `checkCardLimit`, `isPipelineIdle`, `autoArchiveDone`, `runHousekeeping`
- **O(n\u00b2) \u2192 O(n) card enrichment**: `computeDisplay()` dependency and parent lookups now use a `Map<id, card>` built once per `enrichCards()` call. Previously iterated all cards for every dependency check (100 cards = 10,000 iterations; now 100 cards = 100 Map lookups)
- **Aggregation queries**: Added `projectTrustStats` (count+avg score by project), `completedTitles` (done/archive titles), `reviewScores` (all scores), `getByColumn` (cards filtered by column). Eliminates `getAll().concat(getArchived())` full scans in intelligence, brainstorm, and auto-archive
- **O(n*m) auto-labeling**: `autoLabel()` builds a `Map<keyword, rule>` for O(1) lookups instead of nested loop over words x rules. `bumpApplied` tracking uses Set of matched IDs
- **N+1 elimination**: Eliminated 25+ duplicate `cards.get(id)` calls across route handlers. Each create/update/move handler now fetches the card once and reuses the result for broadcast + response
- **Progressive trust SQL**: `getProjectTrust()` uses SQL `COUNT + AVG` aggregation with project index instead of loading all cards then filtering in JS
- **Brainstorm completed work**: `buildBrainstormPrompt()` uses `getCompletedTitles()` SQL query instead of `getAll().concat(getArchived())` full scan
- **Auto-archive targeted**: `autoArchiveDone()` uses `getByColumn('done')` (pre-sorted) instead of loading all cards and filtering
- **analyzeAndTune single-pass**: Review scores collected in same loop as timeout/build stats (was separate `.filter().map()` pass)
- **canBrainstorm merged**: Two separate iterations (brainstorm check + orphan check) consolidated into single pass
- **getDiff merged**: Two passes over `originalFiles` (removed + modified) merged into single pass
- **Removed resetStuckCards**: Superseded by `recoverOrphanedCards()` which has better recovery semantics (building to interrupted vs idle, fixing to fix-interrupted for priority resume)
- **Server middleware dedup**: Extracted `applyCommonMiddleware()` function applied to both public and admin Express apps. Was 14 duplicate middleware registrations, now 7 in one function
- **Server timeout dedup**: Extracted `hardenServer()` function for request/header/keep-alive timeouts. Was 8 duplicate property assignments, now 4 in one function
- **Housekeeping single-pass**: Merged `dirSize()` and `countFiles()` into `dirStats()` that returns both size and file count in a single recursive traversal. Was 10 stat calls per directory (2 functions x 5 dirs), now 5
- **Audit count optimization**: `runHousekeeping()` uses `audit.count()` (O(1) index query) instead of `audit.all().length` (loads all rows into memory)
- **Trends single-pass**: `/api/trends` endpoint computes all stats (weekly buckets, totals, scores, approve rates) in a single iteration. Was 7 separate `.filter()` passes over the full card list
- **Pipeline killAll single-pass**: Consolidated 3 separate iterations over all cards (brainstorm, fix, review) into a single loop
- **Pipeline resume single-pass**: Consolidated 3 separate iterations (rate-limited, fix-interrupted, frozen) into a single loop
- **Escalation dedup search**: `escalateToHuman()` uses `cards.search()` instead of `cards.getAll().find()` for existing escalation check
- **Removed duplicate imports**: Eliminated redundant `runtime` require in server.js (was imported twice)
- **Removed redundant DATA_DIR check**: Was checked 3 times across config.js, db/index.js, and server.js; removed the server.js duplicate

## [2.5.0] - 2026-03-09

### Added
- **Rate-limit detection**: All polling loops (build, brainstorm, review, fix, decompose) now scan CLI log files for rate-limit error patterns (429, quota exceeded, usage limit, etc.). Detection triggers within 30 seconds instead of waiting 15-60 minutes for idle timeout
- **Rate-limited card status**: New `rate-limited` card status preserves which phase (build, brainstorm, review) was interrupted. Cards auto-recover when usage resets, no manual intervention needed
- **Smart usage recovery**: When pipeline pauses due to usage limits, reads `resets_at` from cached API data to predict exact reset time. Schedules auto-resume 1 minute after predicted reset. Max 2 API polls per hour to avoid hammering the endpoint. Falls back to 30-minute cache re-checks if no valid reset time available
- **Pause reason tracking**: Pipeline pause now tracks reason (`user`, `usage-limit`, `rate-limit-detected`). Only usage-related pauses trigger auto-recovery. Manual pauses remain manual
- **Crash resilience**: `uncaughtException` and `unhandledRejection` handlers prevent Node.js from crashing on transient errors. Orchestrator stays alive to resume pipeline when limits reset. Counter resets every 5 minutes; exits only after 10 rapid-fire failures (watchdog restarts)
- **Heartbeat file**: Server writes `.data/.heartbeat` every 30 seconds with PID, uptime, memory, and pipeline state. Used by external watchdog for crash detection
- **Watchdog scripts**: `watchdog.bat` (Windows) and `watchdog.sh` (Unix) monitor heartbeat file, auto-restart server on crash or hang. Kills orphaned node processes before restart. Can run as Task Scheduler job or systemd service
- **Restart marker**: Server writes `.data/.restart-requested` when too many uncaught exceptions occur, signaling watchdog to perform clean restart

### Changed
- **Pipeline state broadcast**: `pipeline-state` SSE event now includes `pauseReason` field for UI to distinguish between manual and automatic pauses
- **Crash recovery**: `recoverOrphanedCards()` now handles `rate-limited` status and auto-starts recovery poller if rate-limited cards exist from previous crash

### Fixed
- **review.js unused import**: Removed `getEffectiveProjectPath` import that was never used

## [2.4.1] - 2026-03-09

### Fixed
- **Critical: brainstorm.js crash** — `log` variable shadowed the Pino logger with a file path string, causing `TypeError: log.error is not a function` when `decomposeSpec()` or auto-start-work failed. Both `executeBrainstorm()` and `decomposeSpec()` had the same bug. Renamed to `bsLogFile`/`dcLogFile`
- **Crash recovery gap** — Cards in `queued` status were not recovered on server restart. Since the work queue is in-memory, these became zombie cards stuck in queue forever. Now reset to `idle` in their current column
- **activeBuilds memory leak** — If `executeWork()` threw after `activeBuilds.set()`, the catch block in `processQueue()` never called `activeBuilds.delete()`, leaking the Map entry and permanently blocking that project path
- **Folder creation ordering** — Project folder was created AFTER `snapshot.take()`, causing snapshot to fail on new projects. Moved `mkdirSync` before snapshot
- **approve-spec missing guards** — Endpoint allowed approving any card regardless of status or column. Now requires `status === 'spec-ready'` AND `column_name === 'brainstorm'`
- **Review finding null safety** — `computeDisplay()` could crash on malformed `review_data`: non-array findings, null finding objects, or findings with missing `message` field. Added `Array.isArray()` guard, null checks per finding, and `message` existence check before string operations
- **Bulk-create column validation** — Invalid column names were accepted without validation. Now skips items with columns not in `VALID_COLUMNS`
- **Command palette listener leak** — Every keystroke in the command palette created new click listeners on result rows. Replaced per-row `addEventListener` with event delegation on the `cmdResults` container
- **Template rendering leak** — Templates were re-fetched from API on every modal open, creating new click listeners each time. Added template caching and event delegation on the grid
- **SSE reconnect data loss** — On SSE disconnect/reconnect, no state sync occurred. Missed events left the UI stale. Now calls `loadCards()` + `loadQueue()` on reconnect
- **Dependency index validation** — `decomposeSpec()` accepted negative or non-integer `depends_on_index` values from AI output. Now validates `Number.isInteger()`, `>= 0`, and `< childIds.length`

### Added
- **Trust level badge** — Cards with project paths now show progressive trust level (building/trusted/proven) as a badge. Computed server-side via `intelligence.getProjectTrust()`
- **Custom prompt size limits** — Admin `PUT /api/custom-prompts` now validates each field against 100KB max. Prevents DoS via oversized prompt injection
- **Snapshot path traversal protection** — `getDiff()` now validates the `projectPath` from snapshot manifests against `validateProjectPath()`. Prevents reading arbitrary files via tampered snapshot `_manifest.json`

## [2.4.0] - 2026-03-09

### Added
- **Crash recovery**: On server startup, detects cards stuck in transient states (building, reviewing, fixing, brainstorming) from previous crashes. Resets each to a recoverable state: building cards become interrupted, reviewing cards reset to idle, fixing cards preserve review findings for resumption, brainstorming cards freeze for restart on resume. Logged with per-card detail
- **Review score breakdown**: Card display now includes category-level finding counts (security, quality, performance, accessibility, completeness) with severity indicators. Replaces opaque single-number score with transparent breakdown visible on every card
- **Build failure summaries**: Cards scoring below 8 show the top critical finding directly on the card badge. No more log diving to understand why a build scored low
- **Progressive trust**: Per-project trust levels (new, building, trusted, proven) based on completed card count and average review scores. Proven projects (10+ builds, avg score >= 7.5) auto-approve at score 7 instead of 8. All threshold changes are checkpoint-protected
- **Card templates**: Six pre-built templates (Bug Report, Feature, Refactor, Security Fix, Performance, Testing) with structured bodies, title prefixes, and default labels. Template picker grid in the idea modal
- **Trend sparklines**: Weekly completion rate sparkline in the header stats bar. `GET /api/trends` endpoint returns 8-week completion history, score trends, auto-approve rate, and success rate
- **Command palette**: `Ctrl+K` / `Cmd+K` opens a quick-action search overlay. Search actions (New Idea, Pause/Resume Pipeline, Toggle Dark Mode, View Archive, Metrics, Control Panel) and cards by title/labels. Full keyboard navigation with arrow keys, Enter to select, Escape to close
- **Spec approval gate**: Optional `SPEC_APPROVAL_GATE=true` setting holds cards in brainstorm column after spec generation. User reviews spec and clicks "Approve Spec" to promote to todo. Skipped in single-project mode. Configurable via control panel

### Changed
- **Auto-approve threshold**: Now dynamic per project via progressive trust instead of hardcoded score >= 8. New projects still require 8, proven projects can auto-approve at 7
- **Header stats**: Now includes trend sparkline and pass-rate indicator alongside existing Total/Active/Queued/Done counts

## [2.3.0] - 2026-03-09

### Added
- **Strategic domain rotation**: Auto-discovery rotates through 10 strategic lenses (Security Audit, Testing Gaps, UX Deep Dive, Architecture Debt, Performance Audit, Accessibility Audit, Error Handling, Data Integrity, Developer Experience, Operational Readiness). LRU selection ensures every domain is visited before any repeats, with random pick within unused pool for variance
- **Domain coverage tracking**: 10 strategic domains with keyword-based detection. Computes coverage from completed cards, identifies NEGLECTED and WEAK areas. Injects coverage analysis into brainstorm prompts, steering specs toward under-addressed domains
- **Confrontational spec challenges**: 5 mandatory challenges every spec must answer: Alternatives Test (name 2 different approaches), Opportunity Cost (what won't get built), Failure Pre-Mortem (imagine it failed), User Reality Check (name a specific persona), Scope Knife (cut 30%, justify the rest). Prevents repetitive, score-chasing specs

### Changed
- **Discovery prompt**: Replaced rogue innovation / highest-impact binary with strategic lens rotation. Each cycle targets a specific domain with surgical precision instead of generic "suggest the best thing"
- **Brainstorm prompt**: Now injects domain coverage analysis and confrontational challenges alongside existing multi-lens and creative constraint sections

### Removed
- **Rogue innovation cycles**: Subsumed by strategic lens rotation which provides better variance with guaranteed domain coverage

## [2.2.0] - 2026-03-09

### Added
- **Spec intelligence service** (`src/services/spec-intelligence.js`): Enterprise-grade specification quality engine with four integrated subsystems
- **Multi-lens brainstorm**: Forces multi-perspective analysis (End User, Adversary, Future Maintainer) before spec writing. Card-type-aware profiles for bug, feature, security, refactor, and performance cards with tailored lens questions per type
- **Historical review injection**: Queries past review findings, spec effectiveness patterns, workflow notes, and feedback themes from the intelligence service. Injects aggregated insights into brainstorm prompts so new specs avoid past mistakes
- **Creative constraints**: 21 context-aware creative thinking prompts (accessibility, resilience, simplicity, user empathy, security, observability, scale, cross-domain). Weighted random selection favors unused constraints. Configurable application rate (default 20% of brainstorms)
- **Spec quality feedback loop**: Computes spec effectiveness score (0-100) after every review cycle. Formula accounts for review score, fix rounds, timeouts, and auto-approval. Learns 18 structural spec features (numbered steps, file paths, code blocks, edge cases, security sections, test plans, etc.) and correlates them with effectiveness over time
- **Spec pattern learning**: Extracts structural features from spec text, tracks running averages per feature, identifies which spec patterns lead to high vs low quality builds. Also learns from absent features in low-scoring specs
- **Card type detection**: Label-first, then title-based regex matching with proper priority ordering (specific security keywords before generic bug keywords, refactor before auth)
- **`spec_score` column**: New card column tracking spec effectiveness, persisted in DB with full audit trail
- **Config knobs**: `multiLensBrainstorm` (bool, default true), `creativeConstraintPct` (0-100, default 20), `specFeedbackLoop` (bool, default true) — all live-configurable via control panel
- **API endpoints**: `GET /api/spec-intelligence` on both public and admin routes — returns spec score distribution, pattern analysis, constraint usage stats, review finding aggregation, and config state

## [2.1.0] - 2026-03-08

### Changed
- **License**: Switched from MIT to Apache 2.0 — requires attribution via NOTICE file in all derivative works
- **NOTICE file**: Added with project attribution, author contact, and SSO integration note for downstream adopters
- **GitHub Actions CI**: Matrix build (Node 18/22 on Ubuntu + Windows) with health check validation
- **CodeQL SAST**: Weekly + push/PR security scanning with `security-and-quality` queries
- **Pitch deck**: 10-slide Guy Kawasaki presentation at `/pitch` — zero deps, dark cinematic theme
- **Public release preparation**: Codebase audited for hardcoded secrets, paths, and personal information — all clean
- **PROJECTS_ROOT default**: Changed from Windows-specific `R:\` to cross-platform `~/Projects` on all OSes
- **README.md rewritten**: Accurate project structure (matches src/ layout), removed hardcoded paths, added security section, complete API reference, proper npm metadata
- **package.json**: Added `repository`, `homepage`, `bugs`, `keywords`, `author`, `license`, `engines` fields for npm/GitHub discoverability
- **.env.example**: Removed hardcoded `R:\` path, commented out optional fields with safe placeholders
- **.gitignore**: Added OS files (.DS_Store, Thumbs.db), IDE directories, additional .env variants
- **Version**: Bumped to 2.1.0

### Fixed
- **start.sh/start.bat**: Entry point corrected from `node server.js` to `node src/server.js` — server would fail to start
- **Architecture docs**: Table count corrected from 11 to 8 (removed phantom `users` and `activities` tables), modal count corrected from 9 to 7
- **API docs**: Added 14 undocumented endpoints (review, sessions, folders, ideas, feedback, promote, config, mode, audit, discovery, pending-actions), removed phantom `admin/verify`, moved `kill-all` to admin, updated SSE events from 6 to 12 types — total endpoints now 79
- **Pitch deck**: License references updated from MIT to Apache 2.0, DB table count corrected, line count updated to 12K, endpoint count updated to 79

## [2.0.0] - 2026-03-08

### Added
- **Pre-automation baseline commit**: Creates a git safety checkpoint (with 0-byte `.pre-automation-checkpoint` marker) before the first build touches a project folder. One checkpoint per project lifetime — subsequent builds skip if marker exists. Gives user a clean revert point to the pre-automation state
- **SSO identity provider** (`src/sso/`): Self-contained auth module — JWT (HS256), Argon2id password hashing (64MB memory, timing-safe), login/logout/session endpoints, HTML login page. Drop-in replaceable with real OIDC/SAML — same interface, zero kanban code changes
- **Role-based access control**: `admin` and `user` roles. Admin-only endpoints enforced via `requireAdmin` middleware. SSO-protected admin panel redirect with role check
- **Intelligence service** (`src/services/intelligence.js`): Self-learning pattern engine — auto-labels cards from keyword patterns, tracks build durations and review scores per project, learns from retry feedback, auto-tunes config on repeated timeouts. 30+ seed rules, user patterns overtake at higher confidence
- **Checkpoint/rollback system**: Every intelligence auto-change creates a revert point. `GET /api/checkpoints`, `POST /api/checkpoints/:id/rollback` accessible from both public board and admin panel
- **Auto-discover service** (`src/services/auto-discover.js`): Single-project mode — scans project folder for TODOs/FIXMEs, decomposes brainstorm initiatives into child cards, periodic discovery at configurable interval. Pending user actions queue for out-of-scope operations
- **Pino structured logging** (`src/lib/logger.js`): JSON output with ISO timestamps, structured fields, correlation IDs via `reqLogger()`. Replaces all `console.log/error` across 8+ files
- **DB error persistence**: `error_log` table (level, source, card_id, message, context JSON, resolved, fix_card_id). Pino hook auto-persists every error/fatal to DB. `GET /api/errors`, `GET /api/errors/recent`, `POST /api/errors/:id/resolve`
- **DB auto-fix scanner**: `scanDbErrors()` runs every 30s — groups unresolved errors by card, triggers `selfHeal()`, escalates after 2 attempts, auto-prunes entries older than 30 days
- **Deep health check**: `GET /health/ready` — DB integrity, disk writability, pipeline state, unresolved error count. Returns 503 with degraded status when unhealthy
- **Factory reset (nuke + clone)**: One-click reset from control panel — backs up `.env`, spawns detached script in parent dir, deletes kanban folder, fresh `git clone`, restores `.env`, `pnpm install`, auto-starts server hidden. Retry loop (5x) handles Windows file locks. Browser polls `/health` and auto-redirects when server is back
- **Single-project mode**: `KANBAN_MODE=single-project` locks board to one folder. Auto-promotes brainstorm cards, configurable discovery interval, max child cards per initiative. Housekeeping pauses pipeline, waits for idle, cleans, resumes
- **Learnings DB table**: `learnings` (category, pattern_key, pattern_value, confidence, occurrences) with CRUD API for admin
- **Intelligence API**: `GET /api/intelligence` (admin), `POST /api/intelligence/analyze` (admin), `DELETE /api/intelligence/learnings/:id` (admin)
- **Config in DB**: Custom prompts, scan markers, PID, ports, admin path all stored in `config` table (key/value/updated_at) — single source of truth, no more marker files

### Changed
- **Auth model replaced**: Deleted `src/lib/session.js` (in-memory session store) and `src/middleware/auth.js` (PIN-based auth). Replaced with enterprise SSO pattern — JWT tokens, Argon2id passwords, session store with 10K cap and oldest-eviction
- **Admin security hardened**: `ADMIN_PORT` randomized (49152–65535) and `ADMIN_PATH` randomized (52-char hex) on every server start. Both stored in DB config. Admin redirect requires SSO session + admin role
- **Env-based credentials**: `ADMIN_PASSWORD` and `USER_PASSWORD` from environment variables. Loud startup warning if using defaults. No more hardcoded or auto-generated PINs
- **All `var` declarations modernized**: Every `src/` file converted to `const`/`let`
- **XFF trust scoped**: `getIp()` only trusts `X-Forwarded-For` from loopback connections — prevents IP spoofing from external requests
- **Open redirect blocked**: `safeReturnUrl()` validates login return parameter — rejects absolute URLs, protocol-relative URLs, and paths outside the app
- **Concurrency enforcement tightened**: `retryWithFeedback()` checks both `activeBuilds.size` and per-project lock before accepting work
- **SSE guard expanded**: `sseGuard` middleware now covers both `/api/events` and `/api/cards/:id/log-stream` endpoints
- **Card count capped**: `MAX_TOTAL_CARDS=500` enforced on create, ideas generation, and bulk-create endpoints
- **Localhost-only spawn**: `requireLocalhost` middleware on `open-vscode`, `open-terminal`, `open-claude`, and `preview` endpoints — blocks remote code execution
- **Factory reset hardened**: Requires `{ "confirm": true }` body. Audit-logged before execution
- **Input validation tightened**: Labels max 1000 chars, depends-on max 500 chars (format-validated), feedback max 10K chars, bulk-create items capped
- **Dependencies updated**: Added `argon2` ^0.44.0, `pino` ^10.3.1
- **Housekeeping orchestrated**: In single-project mode, hourly housekeeping pauses pipeline, waits for idle (max 5 min), cleans, then resumes pipeline and discovery

### Removed
- `src/lib/session.js` — replaced by `src/sso/session-store.js`
- `src/middleware/auth.js` — replaced by `src/sso/` middleware exports

### Fixed
- Security audit #2: 9 findings fixed (XFF trust, open redirect, env credentials, concurrency enforcement, SSE guard, card cap, localhost spawn, factory reset confirmation, input limits)

## [1.9.0] - 2026-03-07

### Fixed
- **[C1/C2] Log path traversal**: Whitelist allowed log types, verify resolved paths stay under LOGS_DIR — blocks `../` and `%5C` traversal on both endpoints
- **[C3] Command injection via project_path**: Validate all project paths — must be absolute, under PROJECTS_ROOT, no shell metacharacters. Enforced at assign-folder and every spawn site
- **[C4] Command injection via run_command**: Whitelist preview commands (pnpm/npm/node only), reject shell metacharacters
- **[C5] Edit-file path traversal**: Validate project_path under PROJECTS_ROOT before file writes, use resolved paths for containment check
- **[C6] Windows .bat prompt injection**: Write prompt to temp file, pipe via `type | claude` — eliminates all bat metachar vectors (%,^,&,|,!,<,>)
- **[H4] PIN timing attack**: Replace manual charCode loop with `crypto.timingSafeEqual` on fixed-size 256-byte buffers
- **[M6] SQLite BUSY errors**: Add `busy_timeout = 5000` pragma — retry on concurrent writes instead of immediate failure
- **[L7] Silent backup failures**: Log all backup errors, track last success time, alert if no backup in 30 minutes

### Added
- **[H1] Auth on all read endpoints**: Every GET API endpoint now requires session authentication
- **[H2] Auth on SSE**: Event stream requires valid session cookie — no anonymous real-time data leak
- **[H3] Auto-generated PIN**: When ADMIN_PIN unset, generates random 6-digit PIN on first run, saves to `.data/.generated-pin`, prints at startup
- **[H5] Session store cap**: Max 10,000 sessions with oldest-eviction — prevents OOM via session flooding
- **[M1] CSP header**: `Content-Security-Policy` with `default-src 'self'`, `frame-ancestors 'none'`
- **[M2] HSTS header**: `Strict-Transport-Security` when behind HTTPS proxy (`X-Forwarded-Proto` or `ENABLE_HSTS=true`)
- **[M3] Secure cookie flag**: Adds `Secure` flag when `SECURE_COOKIES=true` or `NODE_ENV=production`
- **[M4] CSRF hardening**: State-changing requests without `Origin` header must include `X-Requested-With: XMLHttpRequest`. Frontend updated
- **[M5] Webhook SSRF block**: Validates webhook URLs — blocks RFC1918, link-local (169.254), localhost, and loopback addresses
- **[M7] Input length limits**: Title max 500 chars, description 10K, spec 100K — prevents megabyte payloads per card
- **[M8] Rate limit keying**: Admin auth rate limit keyed on IP + User-Agent — prevents shared-localhost lockout
- **[L1] Test endpoint auth**: Test-only state manipulation requires authentication
- **[L2] Graceful shutdown**: SIGTERM/SIGINT drains connections, closes DB, kills active builds, removes PID (5s timeout)
- **[L3] Static asset caching**: `Cache-Control: public, max-age=86400, immutable` for static files; `no-store` only for API
- **[L4] Enhanced fingerprint**: Session binding includes Accept-Language and Accept-Encoding in addition to IP + User-Agent
- **[L6] Factory reset cleanup**: Uses SIGTERM for graceful shutdown instead of `process.exit(0)`
- **[L8] Content-Type validation**: Rejects non-`application/json` on API POST/PUT endpoints (415 Unsupported Media Type)

## [1.8.1] - 2026-03-07

### Fixed
- **Housekeeping guards pipeline**: Periodic cleanup now skips when any card is in working/building/brainstorming/reviewing/fixing state — prevents deleting logs or runtime files that active Claude sessions need. Manual cleanup from control panel still runs unconditionally

### Changed
- README.md rewritten for v1.8.1 — full feature list, two-server docs, complete API reference, configuration table, updated project structure
- `package.json` version bumped to 1.8.1
- `.env.example` updated: `MAX_CONCURRENT_BUILDS` default corrected to 1, added `BACKUP_RETENTION_DAYS`

## [1.8.0] - 2026-03-07

### Added
- **Timestamped rolling backups**: Hot (every 5min), hourly (keep 24), daily (configurable retention). Replaces single-file backup with tiered strategy
- **Timeline-based DR UI**: Visual backup timeline in control panel — color-coded dots (hot/hourly/daily/manual), click to inspect, 2-click restore with safety backup
- **Manual backup creation**: Create labeled backups on demand from control panel
- **Backup retention config**: Configurable daily backup retention days via control panel
- **Factory reset**: Double-confirmation reset (confirm dialog + type "RESET") wipes all data and restarts fresh
- **Periodic housekeeping**: Auto-runs every 30min — prunes old logs (>7d), stale runtime scripts (>24h), snapshot archives (>14d), orphaned markers, excess audit rows (>10K)
- **Housekeeping dashboard**: Disk usage stats grid in control panel System section with "Run Cleanup Now" button
- **Control panel**: Standalone enterprise dashboard — usage, pipeline, build/review config, custom instructions, active processes, system info
- **Real Claude Max usage tracking**: Reads OAuth token, calls Anthropic usage API, auto-pauses pipeline at configurable threshold (default 80%)
- **Runtime config**: Live-editable limits via control panel with SSE broadcast on changes
- **Custom prompts**: Configurable brainstorm/build/review instructions and quality gates injected into all Claude sessions
- **Board-level usage tracking**: Logs every CLI invocation with hourly/weekly session limits
- **Two-server architecture**: Public app on `0.0.0.0:PORT`, admin panel on `127.0.0.1:PORT+1` — admin physically unreachable from external IPs

### Changed
- Import/Export/Metrics buttons moved from kanban header to control panel
- Backup system migrated from single `.bak` file to tiered hot/hourly/daily directories

## [1.7.0] - 2026-03-07

### Added
- **Pipeline pause/resume**: Pause button in header stops new builds from starting. Queued cards stay queued until resume. Resume triggers queue processing
- **Master kill switch**: "Kill All" button terminates all active builds and pauses pipeline. Confirm dialog prevents accidents
- **Stop card**: Red "Stop" button on working cards kills active build immediately, sets status to interrupted
- **Paused indicator**: Blinking red "Paused" chip in stats when pipeline is paused. Resume button pulses green
- **Pipeline control API**: `GET /api/pipeline`, `POST .../pause`, `.../resume`, `.../kill-all`, `POST /api/cards/:id/stop`

## [1.6.0] - 2026-03-07

### Added
- **Cascade revert**: Rejecting/reverting a card auto-blocks all dependent cards (`blocked` status, amber badge). Kills active builds on affected cards
- **Auto-unblock**: When a dependency completes (moves to done), blocked cards automatically unblock and become available for work
- **Activity-based timeout**: Replaces hard timeout with log-activity watchdog — builds only timeout after 15min of no log writes (configurable via `IDLE_TIMEOUT_MINS`). Hard cap at 4x base (~4 hours)
- **Rich brainstorm log streaming**: Claude's brainstorm output mirrored to log file in real-time (poll-based on Windows, native `tee` on Linux)
- **Blocked card UI**: Amber "Blocked" badge, pipeline shows blocked state, Retry/VSCode/Discard actions

### Changed
- Reject endpoint returns `cascaded` array showing which cards were blocked
- Revert-files endpoint also triggers cascade revert
- Approve and move-to-done endpoints call `checkUnblock()` to release blocked cards

## [1.5.0] - 2026-03-07

### Added
- **Pipeline lock through full review cycle**: `activeBuilds` lock held from build start through review/fix/approve — prevents dependent cards from building on unreviewed code
- **3-attempt auto-fix loop**: Cards scoring <8 get up to 3 auto-fix attempts before escalating to human review (replaces single-attempt system)
- **Queue cards stay in Todo**: Queued cards remain in Todo column, only move to Working when build actually starts
- **Approved-by tracking**: Cards now show "AI Approved" (green badge) or "Human Approved" (blue badge) — `approved_by` column in DB
- **Manual approve captures review score**: Approve endpoint reads `.review-complete` file to capture AI review score even on manual approvals
- **Inline file editing in diff viewer**: Edit button on both added and modified files opens a textarea editor with Save/Cancel, writes directly to disk via `POST /api/cards/:id/edit-file`
- **Full content for new files in diff**: Added files now show complete file content (expandable) instead of just filenames
- **Cancel queue action**: Queued cards in Todo show Cancel/VSCode/Log buttons
- **`needsHumanApproval` flag**: AI review only flags cards for human approval on genuinely destructive operations (rm -rf, mass DB changes, security removals)
- **Scoped review prompt**: AI reviewer focuses only on what the specific card was supposed to build, not penalizing for features belonging to other cards/phases

### Changed
- `MAX_CONCURRENT_BUILDS` default reduced from 3 to 1 to prevent resource exhaustion on modest hardware
- `releaseProjectLock()` called at all terminal states: approve, reject, human escalation, max attempts, timeout, parse error
- Dequeue logic handles cards leaving Todo with `queued` status (not just Working)

### Fixed
- Queued cards appearing in Working column instead of staying in Todo
- Next card starting build while previous card still in review
- Stale `reviewFixAttempted` reference (replaced with `reviewFixCount` Map)

## [1.4.0] - 2026-03-07

### Added
- **Info button**: Visible "Info" button on every card for discoverability (replaces hidden title-click)
- **Button tooltips**: All card action buttons now show descriptive tooltips on hover
- **Column collapsing**: Click any column header to collapse/expand its card list (arrow indicator)
- **Mobile layout**: Columns stack vertically on phones (<640px) with scrollable card lists
- **Tablet layout**: Horizontal scroll with snap-to-column on tablets (640-1023px)
- **4K/ultra-wide scaling**: Font sizes, spacing, and components scale up for large screens (>1920px, >3840px)
- **Touch targets**: Buttons and interactive elements meet 36px minimum on touch devices
- **Reduced motion**: Respects `prefers-reduced-motion` system setting
- **Print styles**: Clean printable layout hiding UI chrome

### Changed
- Header wraps gracefully on narrow screens; search goes full-width on mobile
- Import/Export/Archive buttons hidden on very small screens to save space
- Modals slide up from bottom on mobile for thumb-friendly interaction
- `.gitignore` now excludes backup zip files

## [1.3.0] - 2026-03-07

### Added
- **Build timeout**: Configurable timeout (default 60min) prevents runaway builds from blocking queue forever
- **Global concurrency limit**: `MAX_CONCURRENT_BUILDS` (default 3) prevents resource exhaustion
- **Duration tracking**: Phase timing (brainstorm, build, review) recorded per card and displayed on cards
- **Diff viewer**: Side-by-side file change viewer using snapshot comparison (added/modified/removed/unchanged)
- **Spec editing**: Edit spec in detail modal before build; "Build with this Spec" button for quick iteration
- **Retry with feedback**: Keep existing work, send specific instructions to Claude for targeted fixes
- **Card labels/tags**: Comma-separated labels with auto-colored chips (bug, feature, refactor, design, etc.)
- **Card dependencies**: `depends_on` field blocks builds until dependencies complete; queue respects ordering
- **Search**: Real-time search across card titles, descriptions, and labels
- **Dark mode**: System-preference-aware toggle with warm charcoal theme; persisted in localStorage
- **Desktop notifications**: Browser Notification API alerts when cards complete, fail, or need review (off-tab)
- **Metrics dashboard**: Total cards, avg review score, avg durations, completions by day, top projects, label distribution
- **Keyboard shortcuts**: N (new), / (search), D (dark mode), M (metrics), A (archive), ? (help)
- **Preview/run button**: Reads `.task-complete` run_command or package.json scripts to launch dev server
- **Bulk import**: One card per line with `|` separator for title, description, labels
- **Board export**: Full JSON export of all cards + archive with timestamps
- **Webhook support**: `WEBHOOK_URL` env var for outbound notifications on card state changes
- **Configurable review criteria**: `.kanban-review.md` in project root augments AI review prompt
- **Anthropic/Claude branding**: Warm amber palette, diamond logo mark, "by Claude x Divya Mohan" credit

### Changed
- UI redesigned with Anthropic warm amber color palette (light and dark modes)
- `processQueue()` now starts multiple builds up to concurrency limit (was single-dispatch)
- Review prompt reads project-specific `.kanban-review.md` if present
- Changelog type inference now also checks card labels

### Fixed
- Build polling had no timeout (could poll forever) — now enforced at `BUILD_TIMEOUT_MINS`
- Stuck cards with `fixing` status now reset on server restart

## [1.2.0] - 2026-03-07

### Added
- Cross-platform start/stop scripts with auto-install (Node, pnpm, dependencies)
- PID-based server lifecycle management
- Runtime consolidation: all artifacts moved to `.data/` directory

### Changed
- Default branch switched from `master` to `main`
- DB, logs, snapshots, runtime scripts now under `.data/` (gitignored)
- `.gitignore` simplified to 3 entries

## [1.1.0] - 2026-03-07

### Added
- Auto-archive: Done column keeps latest 5 cards, older cards auto-archived
- Archive viewer modal with Restore and Delete actions
- Archive rotation: caps at 50 archived cards, deletes oldest beyond limit
- DB optimization: PRAGMA optimize on startup + WAL checkpoint every 5 min
- One-click file revert for Done and Archived cards (preserves snapshots after approve)
- Revert button in Done column actions and Archive modal
- `POST /api/cards/:id/revert-files` and `GET /api/cards/:id/has-snapshot` endpoints
- Snapshot cleanup on manual card delete and archive rotation
- Google enterprise light theme (Inter font, clean borders, minimal shadows)
- Header stats bar (Total, Active, Queued, Done counts)
- "NEW since last visit" badges with pulse animation
- Relative timestamps on all cards
- Cross-platform support (Windows, macOS, Linux)
- Preflight checks on startup (dirs, CLI tools, shell execution)

### Changed
- Snapshots no longer cleared on approve — preserved for post-approval revert
- UI redesigned from dark theme to Google enterprise light theme

## [1.0.0] - 2026-03-07

### Added
- Kanban board with 5 columns: Brainstorm, Todo, Working, Review, Done
- Claude CLI orchestration for brainstorm, build, review, and auto-fix
- Per-project work queue with priority locking
- AI code review gate (auto-approve >= 8/10, auto-fix 5-7/10)
- Self-healing log scanner with auto-fix (2 attempts) and human escalation
- File snapshot/rollback on reject
- Auto-changelog generation on approve
- Auto-git commit with co-author on approve
- Live log streaming via SSE
- 9-step pipeline progress visualization
- Drag-and-drop card management with auto-triggered actions
- Real-time SSE updates for all state changes
- Folder detection and picker for project assignment
- Dark theme UI with column-specific accent colors
- Toast notifications for async events
- Interrupted card recovery (retry, re-brainstorm, reject, discard)
