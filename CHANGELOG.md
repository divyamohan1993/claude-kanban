# Changelog

All notable changes to this project will be documented in this file.

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
