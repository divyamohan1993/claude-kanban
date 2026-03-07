# Changelog

All notable changes to this project will be documented in this file.

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
