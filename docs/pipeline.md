# Pipeline

## The Build-Review-Ship Cycle

Every card goes through a deterministic pipeline. Each step is a separate Claude Code session — the builder never reviews its own work.

```
         ┌─────────┐
         │  Idea   │  User describes what they want
         └────┬────┘
              ▼
         ┌─────────┐
         │Brainstorm│  Claude generates a detailed spec
         └────┬────┘
              ▼
         ┌─────────┐
         │Snapshot  │  Save every file in the project (pre-work state)
         └────┬────┘
              ▼
         ┌─────────┐
         │  Queue  │  Wait for concurrency slot + dependency resolution
         └────┬────┘
              ▼
         ┌─────────┐
         │  Build  │  Claude codes the feature
         └────┬────┘
              ▼
         ┌─────────┐
         │ Review  │  Separate Claude session scores 1-10
         └────┬────┘
              ▼
      ┌───────┼───────┐
      ▼       ▼       ▼
   ≥8/ok   5-7     <5/crit
   ┌───┐  ┌───┐   ┌─────┐
   │ ✓ │  │Fix│   │Human│
   └─┬─┘  └─┬─┘   └─────┘
     │       │
     │    Re-review
     │    (max 3x)
     ▼
  ┌──────┐
  │Commit│  CHANGELOG + git commit + push
  └──────┘
```

## Queue Mechanics

The work queue enforces:

- **Concurrency limit** — `MAX_CONCURRENT_BUILDS` (default 1). Only N builds run simultaneously.
- **Per-project locking** — One build per project folder at a time, even if global concurrency allows more.
- **Dependency ordering** — Cards with `depends_on` wait until all dependencies reach `done`.
- **Pipeline lock** — The build lock is held through the entire review/fix/approve cycle, not just the build phase. This prevents dependent cards from building on unreviewed code.

Queued cards stay in the Todo column with a "Queued" badge. They only move to Working when the build actually starts.

## Auto-Fix Loop

When a review scores 5-7 (decent but not passing):

1. The review findings are sent to a new Claude session with instructions to fix them
2. After the fix, a fresh review session re-scores
3. This repeats up to 3 times (`MAX_REVIEW_FIX_ATTEMPTS`)
4. If the score still isn't ≥8 after 3 attempts → escalate to human review

The fix prompt is scoped — it only includes the specific findings from the review, not a general "make it better."

## Self-Healing

Three layers of automatic error recovery:

### 1. DB Error Scanner
Runs every 30 seconds. Scans the `error_log` table for unresolved errors, groups them by card, and triggers `selfHeal()` — which creates a fix card with the error context. After 2 failed attempts, stops retrying and marks for human attention. Auto-prunes entries older than 30 days.

### 2. Activity-Based Timeout
Instead of a hard timer, the watchdog monitors log file `mtime`. A build only times out after `IDLE_TIMEOUT_MINS` (default 15) of zero log activity. Hard cap at 4x base (~1 hour). This prevents killing slow-but-working builds.

### 3. Intelligence Engine
Learns from your usage patterns:

- **Auto-labeling** — Tracks which labels you assign to cards with certain keywords. After enough data, auto-applies labels on new cards.
- **Duration tracking** — Records average build/review time per project. Surfaces as insights.
- **Feedback learning** — Extracts keywords from retry feedback to suggest prompt improvements.
- **Config auto-tuning** — If builds frequently timeout, automatically increases the timeout (with a checkpoint for rollback).

Every auto-change creates a checkpoint. Rollback from the control panel or via `POST /api/checkpoints/:id/rollback`.

## Cascade Revert

Rejecting a card triggers a cascade:

1. All files are rolled back to the pre-work snapshot
2. Every card that `depends_on` this card is set to `blocked` status
3. Active builds on dependent cards are killed
4. When the rejected card is later re-approved, blocked cards automatically unblock

This prevents building features on top of rejected code.

## Pipeline Controls

- **Pause** — Stops new builds from starting. In-progress builds continue. Queued cards stay queued.
- **Resume** — Resumes queue processing. Triggers `processQueue()` to start waiting cards.
- **Kill All** — Kills all active builds (brainstorm, build, review, fix) and pauses the pipeline.
- **Stop Card** — Kills a single card's active build. Sets status to `interrupted`.
