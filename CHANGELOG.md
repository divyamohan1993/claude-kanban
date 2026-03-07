# Changelog

All notable changes to this project will be documented in this file.

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
