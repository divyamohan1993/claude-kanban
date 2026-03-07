# Changelog

All notable changes to this project will be documented in this file.

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
