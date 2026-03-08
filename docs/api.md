# API Reference

All endpoints return JSON. Write endpoints require authentication. Read endpoints are open (server controls which actions appear in the UI based on auth status).

## Public Server (port 51777)

### Cards

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/cards` | List all active cards |
| `POST` | `/api/cards` | Create a card |
| `PUT` | `/api/cards/:id` | Update card fields |
| `DELETE` | `/api/cards/:id` | Soft-delete a card |
| `POST` | `/api/cards/:id/move` | Move card to a column |

### Pipeline Actions

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/cards/:id/brainstorm` | Start brainstorm (Claude generates spec) |
| `POST` | `/api/cards/:id/start-work` | Queue card for build |
| `POST` | `/api/cards/:id/approve` | Approve — triggers CHANGELOG + git commit |
| `POST` | `/api/cards/:id/reject` | Reject — rollback files + cascade-block dependents |
| `POST` | `/api/cards/:id/revert-files` | Revert files to pre-work snapshot |
| `POST` | `/api/cards/:id/retry` | Retry build with specific feedback |
| `POST` | `/api/cards/:id/stop` | Kill active build on this card |

### Card Metadata

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `PUT` | `/api/cards/:id/spec` | Update brainstorm spec |
| `PUT` | `/api/cards/:id/labels` | Set labels (comma-separated) |
| `PUT` | `/api/cards/:id/depends-on` | Set dependencies (comma-separated IDs) |

### Inspection

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/cards/:id/diff` | File-level diff (snapshot vs current) |
| `GET` | `/api/cards/:id/has-snapshot` | Check if pre-work snapshot exists |
| `GET` | `/api/cards/:id/log/:type` | Read log file (brainstorm/build/review/fix) |
| `GET` | `/api/cards/:id/log-stream` | SSE stream of live log output |
| `POST` | `/api/cards/:id/edit-file` | Inline file edit (path traversal protected) |
| `POST` | `/api/cards/:id/preview` | Run preview command (whitelisted: pnpm/npm/node) |

### Local Actions (localhost only)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/cards/:id/detect` | Auto-detect project folder |
| `POST` | `/api/cards/:id/assign-folder` | Manually assign project folder |
| `POST` | `/api/cards/:id/open-vscode` | Open project in VS Code |
| `POST` | `/api/cards/:id/open-terminal` | Open terminal at project path |
| `POST` | `/api/cards/:id/open-claude` | Open Claude Code for this card |

### Board

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/archive` | List archived cards |
| `POST` | `/api/cards/:id/unarchive` | Restore from archive |
| `GET` | `/api/search?q=` | Search cards (title, description, labels) |
| `GET` | `/api/export` | Export board JSON (cards only; `?full=true` for admin) |
| `POST` | `/api/bulk-create` | Bulk import cards |
| `GET` | `/api/metrics` | Dashboard stats (scores, durations, counts) |
| `GET` | `/api/queue` | Work queue status |
| `GET` | `/api/activities` | Pipeline event log |

### Pipeline Control

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/pipeline` | Pipeline state (paused, active count, queued) |
| `POST` | `/api/pipeline/pause` | Pause queue processing |
| `POST` | `/api/pipeline/resume` | Resume queue processing |
| `POST` | `/api/pipeline/kill-all` | Kill all builds + pause |

### Real-Time

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/events` | SSE event stream (card updates, log output, config changes) |

### Checkpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/checkpoints` | List intelligence rollback points |
| `POST` | `/api/checkpoints/:id/rollback` | Revert an auto-change |

### Health

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/health` | Liveness probe (200 = running) |
| `GET` | `/health/ready` | Readiness probe (DB integrity, disk, pipeline, errors) |

### Auth

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/auth/login` | Authenticate (returns JWT) |
| `POST` | `/auth/logout` | Clear session |
| `GET` | `/auth/session` | Current session info |

---

## Admin Server (localhost only)

All admin endpoints require the `admin` role.

### Configuration

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/config` | Read runtime config (full env for admin) |
| `PUT` | `/api/config` | Update runtime config (live, no restart) |
| `GET` | `/api/custom-prompts` | Read brainstorm/build/review instructions |
| `PUT` | `/api/custom-prompts` | Update custom instructions |

### Usage

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/usage` | Claude Max usage stats (cached ~1hr) |
| `POST` | `/api/usage/refresh` | Force refresh from Anthropic API |

### Backups

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/backups` | List all backups (hot/hourly/daily/manual) |
| `POST` | `/api/backups/create` | Create labeled manual backup |
| `POST` | `/api/backups/restore` | Restore from backup (safety backup created first) |

### Housekeeping

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/housekeeping` | Disk usage stats |
| `POST` | `/api/housekeeping/run` | Run cleanup now |

### Errors

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/errors` | Unresolved errors |
| `GET` | `/api/errors/recent` | Recent errors (all) |
| `POST` | `/api/errors/:id/resolve` | Mark error resolved |

### Intelligence

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/intelligence` | Learned patterns snapshot |
| `POST` | `/api/intelligence/analyze` | Force analysis cycle |
| `DELETE` | `/api/intelligence/learnings/:id` | Delete a learned pattern |

### Control

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/factory-reset` | Wipe everything (requires `{"confirm": true}`) |
| `POST` | `/api/admin/verify` | Verify admin credentials |

---

## SSE Events

The `/api/events` stream emits these event types:

| Event | Payload | When |
|-------|---------|------|
| `card-updated` | Full card object | Any card state change |
| `card-deleted` | `{ id }` | Card soft-deleted |
| `log-output` | `{ cardId, type, data }` | Build/review log line |
| `pipeline-state` | `{ paused, activeCount }` | Pipeline pause/resume |
| `config-updated` | `{ key, value }` | Runtime config changed |
| `queue-updated` | Queue snapshot | Queue state change |

## Error Response Format

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "requestId": "correlation-id"
}
```

HTTP status codes: 400 (bad input), 401 (not authenticated), 403 (not authorized), 404 (not found), 409 (conflict/dependency), 415 (wrong content-type), 429 (rate limited), 500 (server error).
