const fs = require('fs');
const path = require('path');
const { IS_WIN, IS_MAC, PROJECTS_ROOT, LOGS_DIR, RUNTIME_DIR, runtime, getEffectiveProjectPath } = require('../config');
const { cards } = require('../db');
const { broadcast } = require('../lib/broadcast');
const { killProcess } = require('../lib/process-manager');
const { logPath, suggestName, sendWebhook } = require('../lib/helpers');
const { log } = require('../lib/logger');
const { runClaudeSilent, detectRateLimit } = require('./claude-runner');
const snapshot = require('./snapshot');
const usageSvc = require('./usage');

// Ensure dirs exist
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });

// --- Shared Pipeline State ---
const activePollers = new Map();   // cardId -> interval
const buildPids = new Map();       // cardId -> pid
const workQueue = [];              // [{cardId, priority, projectPath, enqueuedAt}]
const activeBuilds = new Map();    // projectPath -> cardId
let pipelinePaused = false;
let pauseReason = null;            // null | 'user' | 'usage-limit' | 'rate-limit-detected'
let recoveryPoller = null;         // setInterval handle for usage recovery polling
const activeFixes = new Set();     // sourceCardId set (self-heal)
const fixAttempts = new Map();     // sourceCardId -> {count, lastAttempt}
const reviewFixCount = new Map();  // cardId -> fix attempt count
const cardActivity = new Map();    // cardId -> {detail, step, timestamp}

// --- State Accessors (for other services) ---

function getPipelineState() {
  const brainstormSvcState = require('./brainstorm');
  return {
    paused: pipelinePaused,
    pauseReason: pauseReason,
    activeCount: activeBuilds.size,
    queueLength: workQueue.length,
    fixCount: activeFixes.size,
    pollerCount: activePollers.size,
    activeBrainstorms: brainstormSvcState.getActiveBrainstorms(),
    brainstormQueueLength: brainstormSvcState.getBrainstormQueue().length,
    pause: function(reason) {
      pipelinePaused = true;
      pauseReason = reason || 'usage-limit';
      broadcast('pipeline-state', { paused: true, pauseReason: pauseReason });
      startRecoveryPoller();
    },
  };
}

function trackPid(cardId, pid) { if (pid) buildPids.set(cardId, pid); }
function getReviewFixCount(cardId) { return reviewFixCount.get(cardId) || 0; }
function setReviewFixCount(cardId, count) { reviewFixCount.set(cardId, count); }
function deleteReviewFixCount(cardId) { reviewFixCount.delete(cardId); }

// --- Activity Tracking ---

function setActivity(cardId, step, detail) {
  const entry = { cardId: cardId, step: step, detail: detail, timestamp: Date.now() };
  cardActivity.set(cardId, entry);
  broadcast('card-activity', entry);
}

function clearActivity(cardId) {
  cardActivity.delete(cardId);
  broadcast('card-activity', { cardId: cardId, step: null, detail: null, timestamp: Date.now() });
}

function getActivities() {
  const result = {};
  for (const entry of cardActivity) {
    result[entry[0]] = entry[1];
  }
  return result;
}

// --- Duration Tracking ---

function trackPhase(cardId, phase, action) {
  const card = cards.get(cardId);
  if (!card) return;
  let durations = {};
  try { durations = JSON.parse(card.phase_durations || '{}'); } catch (_) {}
  if (action === 'start') {
    durations[phase] = { start: Date.now() };
  } else if (action === 'end' && durations[phase]) {
    durations[phase].end = Date.now();
    durations[phase].duration = durations[phase].end - durations[phase].start;
  }
  cards.setPhaseDurations(cardId, JSON.stringify(durations));
}

// --- Pipeline Pause ---

function setPaused(paused, reason) {
  pipelinePaused = !!paused;
  if (pipelinePaused) {
    pauseReason = reason || 'user';
    if (reason === 'usage-limit' || reason === 'rate-limit-detected') {
      startRecoveryPoller();
    }
  } else {
    pauseReason = null;
    stopRecoveryPoller();

    // Lazy requires to avoid circular deps
    const brainstormSvc = require('./brainstorm');
    const reviewSvc = require('./review');

    // Single pass: recover rate-limited, fix-interrupted, and frozen cards
    const allCards = cards.getAll();
    for (let i = 0; i < allCards.length; i++) {
      const c = allCards[i];

      if (c.status === 'rate-limited') {
        log.info({ cardId: c.id, column: c.column_name, title: c.title }, 'Recovering rate-limited card');
        if (c.column_name === 'brainstorm') {
          cards.setStatus(c.id, 'idle');
          try { brainstormSvc.brainstorm(c.id); } catch (_) {}
        } else if (c.column_name === 'working') {
          cards.setStatus(c.id, 'idle');
          cards.move(c.id, 'todo');
          try { enqueue(c.id, 100); } catch (_) {}
        } else if (c.column_name === 'review') {
          cards.setStatus(c.id, 'idle');
          try { reviewSvc.autoReview(c.id); } catch (_) {}
        } else {
          cards.setStatus(c.id, 'idle');
          if (c.column_name !== 'todo') cards.move(c.id, 'todo');
          try { enqueue(c.id, 50); } catch (_) {}
        }
        broadcast('card-updated', cards.get(c.id));
      } else if (c.status === 'fix-interrupted' && c.column_name === 'todo') {
        try {
          const reviewData = c.review_data ? JSON.parse(c.review_data) : null;
          if (reviewData && reviewData.findings && reviewData.findings.length > 0) {
            cards.move(c.id, 'review');
            cards.setStatus(c.id, 'fixing');
            reviewSvc.autoFixFindings(c.id, reviewData.findings);
          } else {
            cards.setStatus(c.id, 'idle');
            enqueue(c.id, 100);
          }
        } catch (_) {
          cards.setStatus(c.id, 'idle');
          try { enqueue(c.id, 100); } catch (__) {}
        }
      } else if (c.status === 'frozen' && c.column_name === 'brainstorm') {
        cards.setStatus(c.id, 'idle');
        try { brainstormSvc.brainstorm(c.id); } catch (_) {}
      }
    }
    processQueue();
  }
  broadcast('pipeline-state', { paused: pipelinePaused, pauseReason: pauseReason });
  sendWebhook('pipeline-' + (pipelinePaused ? 'paused' : 'resumed'), { reason: pauseReason });
}

function isPaused() { return pipelinePaused; }

// --- Kill All ---

function killAll() {
  pipelinePaused = true;
  const killed = [];

  // 1. Kill active builds
  for (const entry of activeBuilds) {
    const cardId = entry[1];
    const pid = buildPids.get(cardId);
    if (pid) { killProcess(pid); buildPids.delete(cardId); }
    const poller = activePollers.get(cardId);
    if (poller) { clearInterval(poller); activePollers.delete(cardId); }
    const card = cards.get(cardId);
    cards.setStatus(cardId, 'interrupted');
    cards.move(cardId, 'todo');
    setActivity(cardId, 'queue', 'Killed by master kill switch');
    broadcast('card-updated', cards.get(cardId));
    killed.push({ id: cardId, title: card ? card.title : '?', phase: 'build' });
  }
  activeBuilds.clear();

  // 2-4. Single pass: freeze brainstorms, kill fixes, kill reviews
  const brainstormSvcKill = require('./brainstorm');
  const allCards = cards.getAll();
  for (let ci = 0; ci < allCards.length; ci++) {
    const c = allCards[ci];
    if (c.status === 'brainstorming' || c.status === 'brainstorm-queued') {
      const bPid = buildPids.get(c.id);
      if (bPid) { killProcess(bPid); buildPids.delete(c.id); }
      cards.setStatus(c.id, 'frozen');
      setActivity(c.id, 'spec', 'Frozen — will restart on resume');
      broadcast('card-updated', cards.get(c.id));
      killed.push({ id: c.id, title: c.title, phase: c.status === 'brainstorming' ? 'brainstorm' : 'brainstorm-queued' });
    } else if (c.status === 'fixing') {
      const fPid = buildPids.get(c.id);
      if (fPid) { killProcess(fPid); buildPids.delete(c.id); }
      const fPoller = activePollers.get(c.id);
      if (fPoller) { clearInterval(fPoller); activePollers.delete(c.id); }
      cards.setStatus(c.id, 'fix-interrupted');
      cards.move(c.id, 'todo');
      setActivity(c.id, 'queue', 'Fix interrupted — will resume at top priority');
      broadcast('card-updated', cards.get(c.id));
      killed.push({ id: c.id, title: c.title, phase: 'fix' });
    } else if (c.column_name === 'review' && c.status !== 'fix-interrupted') {
      const rPid = buildPids.get(c.id);
      if (rPid) { killProcess(rPid); buildPids.delete(c.id); }
      const rPoller = activePollers.get(c.id);
      if (rPoller) { clearInterval(rPoller); activePollers.delete(c.id); }
      cards.setStatus(c.id, 'interrupted');
      cards.move(c.id, 'todo');
      setActivity(c.id, 'queue', 'Killed by master kill switch');
      broadcast('card-updated', cards.get(c.id));
      killed.push({ id: c.id, title: c.title, phase: 'review' });
    }
  }
  activeFixes.clear();
  brainstormSvcKill.resetBrainstormState();

  // 5. Clear orphans
  for (const pollerEntry of activePollers) { clearInterval(pollerEntry[1]); }
  activePollers.clear();
  for (const pidEntry of buildPids) { killProcess(pidEntry[1]); }
  buildPids.clear();

  // 6. Drain queue
  while (workQueue.length > 0) {
    const qi = workQueue.pop();
    cards.setStatus(qi.cardId, 'idle');
    clearActivity(qi.cardId);
    broadcast('card-updated', cards.get(qi.cardId));
  }

  broadcastQueuePositions();
  broadcast('pipeline-state', { paused: true });
  broadcast('toast', { message: 'Kill switch activated — ' + killed.length + ' process(es) terminated, pipeline paused', type: 'error' });
  sendWebhook('kill-all', { killed: killed });
  return killed;
}

// --- Stop Single Card ---

function stopCard(cardId) {
  const card = cards.get(cardId);
  if (!card) throw new Error('Card not found');

  const result = dequeue(cardId);

  const poller = activePollers.get(cardId);
  if (poller) { clearInterval(poller); activePollers.delete(cardId); }

  if (result.wasBuilding || result.removed) {
    cards.setStatus(cardId, 'interrupted');
    if (card.column_name === 'working') cards.move(cardId, 'todo');
    setActivity(cardId, 'queue', 'Manually stopped');
    broadcast('card-updated', cards.get(cardId));
    broadcast('toast', { message: 'Stopped: ' + card.title, type: 'warning' });
    return { stopped: true, wasBuilding: result.wasBuilding };
  }

  if (card.status === 'reviewing' || card.status === 'fixing') {
    releaseProjectLock(cardId);
    cards.setStatus(cardId, 'interrupted');
    if (card.column_name === 'working') cards.move(cardId, 'todo');
    setActivity(cardId, 'queue', 'Manually stopped');
    broadcast('card-updated', cards.get(cardId));
    broadcast('toast', { message: 'Stopped: ' + card.title, type: 'warning' });
    return { stopped: true, wasReviewing: true };
  }

  return { stopped: false, reason: 'Card not actively building or queued' };
}

// --- Queue Management ---

function enqueue(cardId, priority) {
  const card = cards.get(cardId);
  if (!card) throw new Error('Card not found');
  if (!card.spec) throw new Error('No spec — run brainstorm first');

  if (card.depends_on) {
    const deps = card.depends_on.split(',').map(function(d) { return Number(d.trim()); }).filter(Boolean);
    for (let di = 0; di < deps.length; di++) {
      const depCard = cards.get(deps[di]);
      if (depCard && depCard.column_name !== 'done' && depCard.column_name !== 'archive') {
        throw new Error('Blocked by card #' + deps[di] + ' (' + depCard.title + ')');
      }
    }
  }

  let projectPath = card.project_path;
  if (!projectPath) {
    // Single-project mode: always use the locked folder
    const singlePath = getEffectiveProjectPath();
    if (runtime.mode === 'single-project' && singlePath) {
      projectPath = singlePath;
    } else {
      projectPath = path.join(PROJECTS_ROOT, suggestName(card.title));
    }
    cards.setProjectPath(cardId, projectPath);
  }

  // Single-project mode: enforce folder sandbox
  if (runtime.mode === 'single-project') {
    const singlePath2 = getEffectiveProjectPath();
    if (singlePath2 && path.resolve(projectPath) !== path.resolve(singlePath2)) {
      throw new Error('Single-project mode: all work must be in ' + singlePath2);
    }
  }

  for (const entry of activeBuilds) {
    if (entry[1] === cardId) return { status: 'already-building' };
  }

  const existing = workQueue.find(function(q) { return q.cardId === cardId; });
  if (existing) {
    if (priority > existing.priority) {
      existing.priority = priority;
      sortQueue();
      broadcastQueuePositions();
    }
    return { status: 'queued', position: getQueuePosition(cardId) };
  }

  if (card.column_name !== 'todo' && card.column_name !== 'working') {
    cards.move(cardId, 'todo');
  }
  cards.setStatus(cardId, 'queued');
  setActivity(cardId, 'queue', 'Waiting in build queue...');

  workQueue.push({ cardId: cardId, priority: priority, projectPath: projectPath, enqueuedAt: Date.now() });
  sortQueue();

  broadcast('card-updated', cards.get(cardId));
  broadcastQueuePositions();
  sendWebhook('card-queued', { cardId: cardId, title: card.title });

  if (pipelinePaused) {
    setActivity(cardId, 'queue', 'Paused — waiting for resume');
  } else {
    processQueue();
  }

  return { status: 'queued', position: getQueuePosition(cardId), paused: pipelinePaused };
}

function dequeue(cardId) {
  const idx = workQueue.findIndex(function(q) { return q.cardId === cardId; });
  if (idx >= 0) {
    workQueue.splice(idx, 1);
    broadcastQueuePositions();
    return { removed: true };
  }

  for (const entry of activeBuilds) {
    if (entry[1] === cardId) {
      activeBuilds.delete(entry[0]);
      const poller = activePollers.get(cardId);
      if (poller) { clearInterval(poller); activePollers.delete(cardId); }
      const pid = buildPids.get(cardId);
      if (pid) { killProcess(pid); buildPids.delete(cardId); }
      return { removed: true, wasBuilding: true };
    }
  }

  return { removed: false };
}

function sortQueue() {
  workQueue.sort(function(a, b) {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.enqueuedAt - b.enqueuedAt;
  });
}

function getQueuePosition(cardId) {
  for (let i = 0; i < workQueue.length; i++) {
    if (workQueue[i].cardId === cardId) return i + 1;
  }
  return -1;
}

function getQueueInfo() {
  return {
    queue: workQueue.map(function(q, i) {
      return { cardId: q.cardId, position: i + 1, priority: q.priority ? 'human' : 'ai', projectPath: q.projectPath };
    }),
    active: Array.from(activeBuilds.entries()).map(function(entry) {
      return { cardId: entry[1], projectPath: entry[0] };
    }),
  };
}

function broadcastQueuePositions() {
  broadcast('queue-update', getQueueInfo());
}

function releaseProjectLock(cardId) {
  const card = cards.get(cardId);
  if (!card) return;
  const projectPath = card.project_path;
  if (projectPath && activeBuilds.get(projectPath) === cardId) {
    activeBuilds.delete(projectPath);
    processQueue();
  }
}

// --- Cascade Revert ---

function cascadeRevert(revertedCardId) {
  const allCards = cards.getAll();
  const affected = [];

  for (const c of allCards) {
    if (!c.depends_on) continue;
    const deps = c.depends_on.split(',').map(function(d) { return Number(d.trim()); }).filter(Boolean);
    if (!deps.includes(revertedCardId)) continue;

    let wasActive = false;
    if (c.status === 'building' || c.status === 'reviewing' || c.status === 'fixing' || c.status === 'queued') {
      const dqResult = dequeue(c.id);
      wasActive = dqResult.wasBuilding || dqResult.removed;
      const reviewPoller = activePollers.get(c.id);
      if (reviewPoller) { clearInterval(reviewPoller); activePollers.delete(c.id); }
    }

    if (c.column_name !== 'done' && c.column_name !== 'archive') {
      cards.setStatus(c.id, 'blocked');
      if (c.column_name !== 'todo') cards.move(c.id, 'todo');
      setActivity(c.id, 'queue', 'Blocked — dependency #' + revertedCardId + ' was reverted');
      broadcast('card-updated', cards.get(c.id));
      affected.push({ id: c.id, title: c.title, wasActive: wasActive });
    }
  }

  if (affected.length > 0) {
    broadcast('toast', { message: 'Reverted card #' + revertedCardId + ' — blocked ' + affected.length + ' dependent card(s)', type: 'error' });
    sendWebhook('cascade-revert', { revertedCardId: revertedCardId, affected: affected });
  }

  return affected;
}

function checkUnblock() {
  const allCards = cards.getAll();
  const unblocked = [];

  for (const c of allCards) {
    if (c.status !== 'blocked') continue;
    if (!c.depends_on) {
      cards.setStatus(c.id, 'idle');
      clearActivity(c.id);
      broadcast('card-updated', cards.get(c.id));
      unblocked.push(c.id);
      continue;
    }

    const deps = c.depends_on.split(',').map(function(d) { return Number(d.trim()); }).filter(Boolean);
    let allSatisfied = true;
    for (let di = 0; di < deps.length; di++) {
      const depCard = cards.get(deps[di]);
      if (depCard && depCard.column_name !== 'done' && depCard.column_name !== 'archive') {
        allSatisfied = false;
        break;
      }
    }

    if (allSatisfied) {
      cards.setStatus(c.id, 'idle');
      clearActivity(c.id);
      broadcast('card-updated', cards.get(c.id));
      broadcast('toast', { message: 'Unblocked: ' + c.title, type: 'success' });
      unblocked.push(c.id);

      // Autonomous: auto-enqueue unblocked cards so pipeline keeps moving
      // Skip cards explicitly rejected by a human
      if (runtime.mode === 'single-project' && runtime.autoPromoteBrainstorm && c.spec && c.approved_by !== 'human-rejected') {
        try { enqueue(c.id, 0); } catch (_) {}
      }
    }
  }

  return unblocked;
}

// --- Rate-Limit Recovery ---
// Smart recovery: uses cached usage data + resets_at timestamps to predict
// when limits will reset. Schedules auto-resume 1 minute after predicted reset.
// Max 2 API polls per hour to avoid hammering the usage endpoint.

let recoveryApiPollCount = 0;    // API polls this hour
let recoveryApiPollResetAt = 0;  // When to reset the hourly poll counter
// Use runtime.maxRecoveryPollsPerHour instead of constant

function startRecoveryPoller() {
  if (recoveryPoller) return; // Already running

  // Fetch fresh usage data (counts as 1 of max 2 polls/hr)
  recoveryApiFetch().then(function() {
    scheduleRecoveryResume();
  });
}

// Fetch usage from API, respecting the 2-per-hour budget
function recoveryApiFetch() {
  const now = Date.now();
  if (now > recoveryApiPollResetAt) {
    recoveryApiPollCount = 0;
    recoveryApiPollResetAt = now + 60 * 60 * 1000; // Reset counter in 1 hour
  }

  if (recoveryApiPollCount >= runtime.maxRecoveryPollsPerHour) {
    log.info('Recovery: API poll budget exhausted (' + runtime.maxRecoveryPollsPerHour + '/hr) — using cached data');
    return Promise.resolve(null);
  }

  recoveryApiPollCount++;
  log.info({ poll: recoveryApiPollCount + '/' + runtime.maxRecoveryPollsPerHour }, 'Recovery: fetching fresh usage from API');

  return usageSvc.fetchClaudeUsage(true).then(function(data) {
    if (data) {
      broadcast('usage-update', usageSvc.getUsageStats());
    }
    return data;
  }).catch(function(err) {
    log.error({ err: err.message }, 'Recovery API fetch failed');
    return null;
  });
}

// Compute when to auto-resume based on cached usage data and resets_at.
// Uses consumption rate to predict when usage will hit 100%, then waits
// for the resets_at time + 1 minute buffer.
function scheduleRecoveryResume() {
  if (recoveryPoller) { clearTimeout(recoveryPoller); recoveryPoller = null; }

  const cached = usageSvc.getUsageStats();
  if (!cached || !cached.plan) {
    // No data — fallback: check again in 30 minutes using cache only
    log.warn('Recovery: no usage data available — will retry in 30 min');
    broadcast('toast', { message: 'No usage data — will retry recovery in 30 min', type: 'info' });
    recoveryPoller = setTimeout(function() {
      recoveryPoller = null;
      recoveryApiFetch().then(function() { scheduleRecoveryResume(); });
    }, 30 * 60 * 1000);
    return;
  }

  const sessionPct = cached.plan.session ? cached.plan.session.utilization : 0;
  const weeklyPct = cached.plan.weekly ? cached.plan.weekly.utilization : 0;
  const threshold = runtime.usagePausePct;

  // Already below threshold? Resume now
  if (sessionPct < threshold && weeklyPct < threshold) {
    log.info({ sessionPct, weeklyPct }, 'Usage already below threshold — auto-resuming');
    broadcast('toast', { message: 'Usage below ' + threshold + '% — auto-resuming pipeline', type: 'success' });
    sendWebhook('usage-recovered', { session: sessionPct, weekly: weeklyPct });
    recoveryPoller = null;
    setPaused(false);
    return;
  }

  // Determine which limit is the bottleneck and when it resets
  const sessionReset = cached.plan.session && cached.plan.session.resetsAt ? new Date(cached.plan.session.resetsAt).getTime() : 0;
  const weeklyReset = cached.plan.weekly && cached.plan.weekly.resetsAt ? new Date(cached.plan.weekly.resetsAt).getTime() : 0;

  let waitMs = 0;
  let resetSource = '';
  const now = Date.now();
  const ONE_MINUTE = 60 * 1000;

  if (sessionPct >= threshold && sessionReset > now) {
    waitMs = sessionReset - now + ONE_MINUTE;
    resetSource = 'session (5hr window resets at ' + new Date(sessionReset).toISOString() + ')';
  } else if (weeklyPct >= threshold && weeklyReset > now) {
    waitMs = weeklyReset - now + ONE_MINUTE;
    resetSource = 'weekly (7-day window resets at ' + new Date(weeklyReset).toISOString() + ')';
  }

  // Sanity cap: never wait more than 6 hours. If resets_at is missing or far future, re-poll
  const MAX_WAIT = runtime.maxRecoveryWaitHours * 60 * 60 * 1000;
  if (waitMs <= 0 || waitMs > MAX_WAIT) {
    // No valid reset time — fallback: use API poll to get fresh data in 30 min
    waitMs = 30 * 60 * 1000;
    resetSource = 'unknown (no valid resets_at — will re-check in 30 min)';
  }

  const waitMin = Math.round(waitMs / 60000);
  const resumeAt = new Date(now + waitMs).toISOString();

  log.info({ waitMin, resetSource, resumeAt, sessionPct, weeklyPct }, 'Recovery: scheduled auto-resume');
  broadcast('toast', {
    message: 'Pipeline paused (' + resetSource + '). Auto-resume in ' + waitMin + ' min at ' + resumeAt,
    type: 'info',
  });
  sendWebhook('recovery-scheduled', { waitMin: waitMin, resumeAt: resumeAt, source: resetSource });

  recoveryPoller = setTimeout(function() {
    recoveryPoller = null;
    // Fetch fresh data (2nd poll if within budget) to confirm limits have reset
    recoveryApiFetch().then(function(data) {
      const freshStats = usageSvc.getUsageStats();
      const sPct = freshStats && freshStats.plan && freshStats.plan.session ? freshStats.plan.session.utilization : 0;
      const wPct = freshStats && freshStats.plan && freshStats.plan.weekly ? freshStats.plan.weekly.utilization : 0;

      if (sPct < threshold && wPct < threshold) {
        log.info({ sessionPct: sPct, weeklyPct: wPct }, 'Usage confirmed below threshold — auto-resuming');
        broadcast('toast', { message: 'Usage reset confirmed — auto-resuming pipeline!', type: 'success' });
        sendWebhook('usage-recovered', { session: sPct, weekly: wPct });
        setPaused(false);
      } else {
        // Still over — reschedule with fresh resets_at
        log.info({ sessionPct: sPct, weeklyPct: wPct }, 'Still over threshold after scheduled resume — rescheduling');
        broadcast('toast', { message: 'Still rate-limited (session: ' + sPct + '%, weekly: ' + wPct + '%). Rescheduling...', type: 'info' });
        scheduleRecoveryResume();
      }
    });
  }, waitMs);
}

function stopRecoveryPoller() {
  if (recoveryPoller) {
    clearTimeout(recoveryPoller);
    recoveryPoller = null;
    recoveryApiPollCount = 0;
    log.info('Usage recovery poller stopped');
  }
}

// Called by polling loops when rate-limit is detected in a child process.
// Immediately pauses pipeline and sets card to rate-limited status.
function handleRateLimitDetected(cardId, phase, logFile) {
  const card = cards.get(cardId);
  const title = card ? card.title : 'Card #' + cardId;

  log.error({ cardId, phase, title }, 'Rate limit detected in CLI output — pausing pipeline');

  // Kill the child process
  const pid = buildPids.get(cardId);
  if (pid) { killProcess(pid); buildPids.delete(cardId); }

  // Set card to rate-limited (preserves column so recovery knows where to resume)
  cards.setStatus(cardId, 'rate-limited');
  setActivity(cardId, phase, 'Rate-limited — will auto-resume when limits reset');
  broadcast('card-updated', cards.get(cardId));

  // Release build lock without triggering processQueue (pipeline is about to pause)
  if (card && card.project_path) {
    activeBuilds.delete(card.project_path);
  }

  // Append to log
  try { fs.appendFileSync(logFile, '\n---\n[' + new Date().toISOString() + '] RATE LIMIT DETECTED — pipeline paused, card will auto-recover\n'); } catch (_) {}

  broadcast('toast', { message: 'Rate limit hit during ' + phase + ': ' + title + ' — pipeline paused, auto-recovery active', type: 'error' });
  sendWebhook('rate-limit-detected', { cardId: cardId, title: title, phase: phase });

  // Pause pipeline with rate-limit reason (starts recovery poller)
  if (!pipelinePaused) {
    setPaused(true, 'rate-limit-detected');
  }
}

// --- Process Queue ---

function processQueue() {
  if (pipelinePaused) return;
  const limits = usageSvc.checkUsageLimits(getPipelineState());
  if (!limits.allowed) return;
  if (activeBuilds.size >= runtime.maxConcurrentBuilds) return;

  for (let i = 0; i < workQueue.length; i++) {
    const item = workQueue[i];
    if (activeBuilds.has(item.projectPath)) continue;

    const card = cards.get(item.cardId);
    if (card && card.depends_on) {
      const deps = card.depends_on.split(',').map(function(d) { return Number(d.trim()); }).filter(Boolean);
      let blocked = false;
      for (let di = 0; di < deps.length; di++) {
        const depCard = cards.get(deps[di]);
        if (depCard && depCard.column_name !== 'done' && depCard.column_name !== 'archive') {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
    }

    workQueue.splice(i, 1);
    try {
      executeWork(item.cardId, item.projectPath);
    } catch (err) {
      log.error({ cardId: item.cardId, err: err.message }, 'executeWork failed');
      cards.setStatus(item.cardId, 'idle');
      cards.move(item.cardId, 'todo');
      activeBuilds.delete(item.projectPath);
      broadcast('card-updated', cards.get(item.cardId));
    }
    broadcastQueuePositions();
    if (activeBuilds.size >= runtime.maxConcurrentBuilds) return;
    i--;
  }
}

// --- Execute Work ---

function executeWork(cardId, projectPath) {
  const card = cards.get(cardId);
  if (!card) return;

  const isExisting = projectPath && fs.existsSync(projectPath);

  if (card.column_name !== 'working') {
    cards.move(cardId, 'working');
    broadcast('card-updated', cards.get(cardId));
  }
  activeBuilds.set(projectPath, cardId);
  setActivity(cardId, 'snapshot', 'Taking file snapshot...');
  trackPhase(cardId, 'build', 'start');

  // Ensure folder exists before snapshot or completion file cleanup
  if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });

  const completionFile = path.join(projectPath, '.task-complete');
  try { fs.unlinkSync(completionFile); } catch (_) {}

  let snapInfo;
  try {
    snapInfo = snapshot.take(cardId, projectPath);
  } catch (err) {
    log.error({ cardId, err: err.message }, 'Snapshot failed');
    activeBuilds.delete(projectPath);
    clearActivity(cardId);
    throw err;
  }

  setActivity(cardId, 'snapshot', 'Snapshot taken (' + snapInfo.fileCount + ' files)');

  // Pre-build baseline commit — second safety checkpoint before files are modified
  try {
    const git = require('./git');
    const baseline = git.baselineCommit(cardId);
    if (baseline.success) {
      setActivity(cardId, 'checkpoint', 'Pre-build baseline committed');
    }
  } catch (err) {
    log.warn({ cardId, err: err.message }, 'Pre-build baseline commit failed (non-fatal)');
  }

  // Build CLAUDE.md
  const claudeParts = ['# Task: ' + card.title, ''];
  if (isExisting) {
    claudeParts.push('## Existing Project');
    claudeParts.push('This is an EXISTING project. Do NOT start from scratch.');
    claudeParts.push('Read and understand the current codebase before making changes.');
    claudeParts.push('');
  }
  claudeParts.push('## Specification');
  claudeParts.push('');
  claudeParts.push(card.spec);
  claudeParts.push('');
  claudeParts.push('## Instructions');
  claudeParts.push('');
  claudeParts.push('You are an autonomous AI coding agent and orchestrator.');
  claudeParts.push('You have full access to subagents and agent teams. Use them for parallel work.');
  claudeParts.push('');

  if (isExisting) {
    claudeParts.push('1. Read and understand the existing codebase first');
    claudeParts.push('2. Plan your changes carefully — do not break existing functionality');
    claudeParts.push('3. Implement the requested changes/features');
    claudeParts.push('4. Test that both existing and new functionality works');
  } else {
    claudeParts.push('1. Initialize the project (package.json, dependencies, etc.)');
    claudeParts.push('2. Implement all features described in the spec');
    claudeParts.push('3. Ensure the application runs without errors');
    claudeParts.push('4. Test core functionality');
  }

  claudeParts.push('5. When fully done, create `.task-complete` in the project root:');
  claudeParts.push('   ```json');
  claudeParts.push('   {"status":"complete","summary":"What was built/changed","run_command":"How to start","files_changed":["list","of","files"],"notes":"Any notes"}');
  claudeParts.push('   ```');
  claudeParts.push('');
  claudeParts.push('## Constraints');
  claudeParts.push('- Use pnpm as package manager (never npm or yarn)');
  claudeParts.push('- Do NOT modify files outside this project directory');
  claudeParts.push('- For any servers/services, use random high ports (49152-65535 range) — NEVER use common ports like 3000, 3333, 4000, 5000, 8000, 8080, etc.');

  // Single-project mode: strict folder sandbox + destructive action flagging
  if (runtime.mode === 'single-project') {
    claudeParts.push('');
    claudeParts.push('## STRICT SANDBOX (Single-Project Mode)');
    claudeParts.push('- You are operating in SINGLE-PROJECT mode. The ONLY directory you may touch is: ' + projectPath);
    claudeParts.push('- Any operation outside this directory is FORBIDDEN. If you need something from outside, note it in .task-complete under "pending_actions" and continue.');
    claudeParts.push('- ALL destructive operations (rm -rf, mass delete, dropping tables, removing security) MUST be flagged in .task-complete under "destructive_flags".');
    claudeParts.push('- Do NOT create, modify, or delete files in parent directories, sibling directories, or system paths.');
  }
  claudeParts.push('');
  claudeParts.push('## Code Quality Standards');
  claudeParts.push('');
  claudeParts.push("**Complete or don't ship.** Every deliverable must work end-to-end. No \"TODO: implement later\" in user-facing paths. If scope must shrink, shrink features, never completeness.");
  claudeParts.push('');
  claudeParts.push('**Code**: Single responsibility. YAGNI, DRY, KISS. Optimize for readability. Design for extension without modification. Target O(1) complexity; when impossible, use the lowest achievable. Never ship O(n^2)+ without explicit justification.');
  claudeParts.push('');
  claudeParts.push('**Security**: Zero trust — verify every layer. All input hostile, server-side validation non-negotiable. Least privilege. OWASP Top 10 as checklist. Parameterized queries only. No dynamic code execution, no raw HTML injection. Output encoding on all user content. TLS 1.3 minimum. HSTS/X-Content-Type-Options/X-Frame-Options/CSP on every response.');
  claudeParts.push('');
  claudeParts.push('**Performance**: Measure before optimizing. Cache-first architecture. p95 API < 200ms, LCP < 2.5s, bundle < 200KB gzip.');
  claudeParts.push('');
  claudeParts.push('**Accessibility**: WCAG 2.2 AA minimum. Keyboard-navigable, screen-reader support (ARIA labels, landmarks, live regions). Semantic HTML, logical focus order, alt text on every image, no information conveyed by color alone. Reduced motion respected.');
  claudeParts.push('');
  claudeParts.push('**Naming**: Files `kebab-case.ts`, components `PascalCase.tsx`, functions/variables `camelCase`, constants `UPPER_SNAKE_CASE`. DB `snake_case` columns, plural tables. API routes `kebab-case`.');
  claudeParts.push('');
  claudeParts.push('**APIs**: Resources/nouns not actions. Paginate, filter, rate-limit from start. Error schema: `{ error, code, requestId, details? }` — uniform, every endpoint.');
  claudeParts.push('');
  claudeParts.push('**Resilience**: Fail fast, loud, safely. Retry with backoff+jitter, idempotent ops only.');
  claudeParts.push('');
  claudeParts.push('**Frontend**: Skeuomorphic, eye-catching UI — tactile depth, micro-interactions, cinematic transitions. Catch attention in the first second. Every pixel intentional. If it could be mistaken for a template, redesign it.');
  claudeParts.push('');
  claudeParts.push('**Testing**: Test behavior not implementation. Ensure the application runs without errors before marking complete.');

  const cp = usageSvc.getCustomPrompts();
  if (cp.buildInstructions) {
    claudeParts.push('');
    claudeParts.push('## Additional Build Instructions');
    claudeParts.push(cp.buildInstructions);
  }
  if (cp.qualityGates) {
    claudeParts.push('');
    claudeParts.push('## Additional Quality Gates');
    claudeParts.push(cp.qualityGates);
  }

  const { sanitizeForFile } = require('./claude-runner');
  fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), sanitizeForFile(claudeParts.join('\n')));
  setActivity(cardId, 'build', 'CLAUDE.md written — launching Claude...');

  const buildLog = logPath(cardId, 'build');
  const header = '[' + new Date().toISOString() + '] Build started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\n'
    + 'Mode: ' + (isExisting ? 'EXISTING' : 'NEW') + '\nSnapshot: ' + snapInfo.fileCount + ' files\n---\n';
  fs.writeFileSync(buildLog, header);

  const buildPrompt = 'Read CLAUDE.md and complete the task as specified. You are an autonomous orchestrator with FULL access to all tools — use subagents, agent teams, web search, file operations, terminal commands — whatever it takes. Maximize parallelism. Think deeply. Deliver production-quality work. When fully done, create .task-complete file as instructed in CLAUDE.md.';

  const run = runClaudeSilent({
    id: 'build-' + cardId,
    cardId: cardId,
    cwd: projectPath,
    prompt: buildPrompt,
    stdoutFile: null,
    logFile: buildLog,
  });

  buildPids.set(cardId, run.pid);
  cards.setStatus(cardId, 'building');
  broadcast('card-updated', cards.get(cardId));
  setActivity(cardId, 'build', 'Claude is coding...');
  sendWebhook('build-started', { cardId: cardId, title: card.title, projectPath: projectPath });

  pollForCompletion(cardId, projectPath);

  return { success: true, projectPath: projectPath, isExisting: isExisting, snapshotFiles: snapInfo.fileCount };
}

function startWork(cardId) {
  return enqueue(cardId, 1);
}

// --- Build Polling ---

function pollForCompletion(cardId, projectPath) {
  const completionFile = path.join(projectPath, '.task-complete');
  const buildLog = logPath(cardId, 'build');
  let pollCount = 0;

  const interval = setInterval(function() {
    pollCount++;
    let needsQueueProcess = false;
    try {
      const card = cards.get(cardId);
      if (!card || card.column_name !== 'working') {
        clearInterval(interval);
        activePollers.delete(cardId);
        activeBuilds.delete(projectPath);
        buildPids.delete(cardId);
        needsQueueProcess = true;
        return;
      }

      // Rate-limit fast-fail: check log for rate-limit errors after minimum polls
      if (pollCount >= runtime.rateLimitMinPolls && pollCount % 3 === 0) {
        const rl = detectRateLimit(buildLog);
        if (rl.detected) {
          clearInterval(interval);
          activePollers.delete(cardId);
          trackPhase(cardId, 'build', 'end');
          handleRateLimitDetected(cardId, 'build', buildLog);
          return;
        }
      }

      let isIdle = false;
      let idleMinutes = 0;
      try {
        const logStat = fs.statSync(buildLog);
        const msSinceWrite = Date.now() - logStat.mtimeMs;
        idleMinutes = Math.round(msSinceWrite / 60000);
        isIdle = msSinceWrite > runtime.idleTimeoutMs;
      } catch (_) {
        isIdle = pollCount >= runtime.buildTimeoutPolls;
        idleMinutes = Math.round(pollCount * 5 / 60);
      }
      const hardTimeout = pollCount >= runtime.buildTimeoutPolls * 4;

      if (isIdle || hardTimeout) {
        const reason = hardTimeout ? 'Hard limit (' + Math.round(pollCount * 5 / 60) + ' min)' : 'Idle for ' + idleMinutes + ' min (no log activity)';
        clearInterval(interval);
        activePollers.delete(cardId);
        activeBuilds.delete(projectPath);
        trackPhase(cardId, 'build', 'end');
        const pid = buildPids.get(cardId);
        if (pid) { killProcess(pid); buildPids.delete(cardId); }
        try { fs.appendFileSync(buildLog, '\n---\n[' + new Date().toISOString() + '] TIMEOUT — ' + reason + '\n'); } catch (_) {}
        sendWebhook('build-timeout', { cardId: cardId, title: card.title, reason: reason });

        if (runtime.mode === 'single-project' && runtime.autoPromoteBrainstorm) {
          // Autonomous: retry once, then rollback and skip so pipeline continues
          const buildRetryKey = 'build-timeout-' + cardId;
          const retries = reviewFixCount.get(buildRetryKey) || 0;
          if (retries < 1) {
            reviewFixCount.set(buildRetryKey, retries + 1);
            log.info({ cardId, reason }, 'Autonomous: retrying build after timeout');
            cards.setStatus(cardId, 'idle');
            cards.move(cardId, 'todo');
            setActivity(cardId, 'queue', 'Build timed out — retrying...');
            broadcast('card-updated', cards.get(cardId));
            try { enqueue(cardId, 0); } catch (_) {}
          } else {
            reviewFixCount.delete(buildRetryKey);
            log.warn({ cardId, reason }, 'Autonomous: skipping card after repeated build timeouts');
            snapshot.rollback(cardId);
            cards.setStatus(cardId, 'complete');
            cards.setApprovedBy(cardId, 'ai-autonomous');
            cards.move(cardId, 'done');
            cards.setSessionLog(cardId, 'Build timed out twice — skipped. Reason: ' + reason);
            setActivity(cardId, 'done', 'Skipped — build timed out twice');
            broadcast('card-updated', cards.get(cardId));
            try { require('./review').checkParentInitiativeComplete(cardId); } catch (_) {}
          }
        } else {
          cards.setStatus(cardId, 'interrupted');
          broadcast('card-updated', cards.get(cardId));
          setActivity(cardId, 'build', 'TIMEOUT — ' + reason);
          broadcast('toast', { message: 'Build timed out (' + reason + '): ' + card.title, type: 'error' });
        }
        needsQueueProcess = true;
        return;
      }

      if (fs.existsSync(completionFile)) {
        clearInterval(interval);
        activePollers.delete(cardId);
        buildPids.delete(cardId);
        trackPhase(cardId, 'build', 'end');

        const content = fs.readFileSync(completionFile, 'utf-8');
        cards.setSessionLog(cardId, content);

        // Single-project mode: check for pending actions and destructive flags
        if (runtime.mode === 'single-project') {
          try {
            const taskData = JSON.parse(content);
            const autoDiscover = require('./auto-discover');
            if (taskData.pending_actions && taskData.pending_actions.length > 0) {
              for (let pa = 0; pa < taskData.pending_actions.length; pa++) {
                autoDiscover.addPendingAction('build-request', taskData.pending_actions[pa], false);
              }
            }
            if (taskData.destructive_flags && taskData.destructive_flags.length > 0) {
              for (let df = 0; df < taskData.destructive_flags.length; df++) {
                autoDiscover.addPendingAction('destructive-op', taskData.destructive_flags[df], !runtime.autoPromoteBrainstorm);
              }
              if (!runtime.autoPromoteBrainstorm) {
                // Manual mode: freeze for human approval
                cards.setStatus(cardId, 'idle');
                cards.move(cardId, 'review');
                setActivity(cardId, 'review', 'FLAGGED: Destructive operations detected — needs human approval');
                broadcast('card-updated', cards.get(cardId));
                broadcast('toast', { message: 'Destructive ops flagged — human review required: ' + card.title, type: 'error' });
                return;
              }
              // Autonomous: log warning, proceed to review (reviewer will also see the flags)
              log.warn({ cardId, flags: taskData.destructive_flags }, 'Autonomous: proceeding past destructive flags');
              broadcast('toast', { message: 'Destructive ops noted (autonomous) — proceeding to review: ' + card.title, type: 'warning' });
            }
          } catch (_) {}
        }

        cards.setStatus(cardId, 'idle');
        cards.move(cardId, 'review');
        setActivity(cardId, 'review', 'Build complete — starting AI review...');
        broadcast('card-updated', cards.get(cardId));
        sendWebhook('build-complete', { cardId: cardId, title: card.title });

        try { fs.appendFileSync(buildLog, '\n---\n[' + new Date().toISOString() + '] Build completed\n' + content + '\n'); } catch (_) {}

        // Lazy require review to avoid circular dep
        try {
          const reviewSvc = require('./review');
          reviewSvc.autoReview(cardId);
        } catch (reviewErr) {
          log.error({ cardId, err: reviewErr.message }, 'autoReview failed');
          try { fs.appendFileSync(buildLog, '\n[ERROR] autoReview failed: ' + reviewErr.message + '\n'); } catch (_) {}
          cards.setStatus(cardId, 'idle');
          broadcast('card-updated', cards.get(cardId));
          broadcast('toast', { message: 'AI Review failed to start: ' + reviewErr.message, type: 'error' });
        }
      }
    } catch (err) {
      log.error({ cardId, err: err.message }, 'pollForCompletion error');
    } finally {
      if (needsQueueProcess) {
        try { processQueue(); } catch (e) { log.error({ err: e.message }, 'processQueue error'); }
      }
    }
  }, runtime.pollIntervalMs);

  activePollers.set(cardId, interval);
}

// --- Self-Healing ---

function selfHeal(sourceCardId, errors, sourceLogFile) {
  if (activeFixes.has(sourceCardId)) return { status: 'already-fixing' };

  const attempts = fixAttempts.get(sourceCardId) || { count: 0, lastAttempt: 0 };
  if (attempts.count >= runtime.maxFixAttempts) return { status: 'max-attempts', count: attempts.count };

  const card = cards.get(sourceCardId);
  if (!card || !card.project_path) return { status: 'no-project' };
  if (!fs.existsSync(card.project_path)) return { status: 'project-missing' };
  if (activeBuilds.has(card.project_path)) return { status: 'build-active' };

  activeFixes.add(sourceCardId);
  attempts.count++;
  attempts.lastAttempt = Date.now();
  fixAttempts.set(sourceCardId, attempts);

  const projectPath = card.project_path;
  const fixLog = logPath(sourceCardId, 'fix-' + attempts.count);
  const fixFile = path.join(projectPath, '.fix-complete');

  try { fs.unlinkSync(fixFile); } catch (_) {}

  const header = '[' + new Date().toISOString() + '] Self-heal attempt ' + attempts.count + '/' + runtime.maxFixAttempts + '\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\nErrors: ' + errors.length + '\n---\n';
  fs.writeFileSync(fixLog, header);

  let logContext = '';
  try {
    if (sourceLogFile && fs.existsSync(sourceLogFile)) {
      logContext = fs.readFileSync(sourceLogFile, 'utf-8').slice(-3000);
    }
  } catch (_) {}

  const prompt = [
    'You are an autonomous error-fixing agent with FULL tool access. Errors were detected in this project.',
    '',
    '## Errors Found',
    errors.join('\n'),
    '',
    '## Log Context (last portion)',
    logContext,
    '',
    '## Instructions',
    '1. Read the relevant source files to understand the root cause',
    '2. Fix the errors — do NOT break existing functionality',
    '3. If the error is a missing dependency, install it with pnpm',
    '4. If the error is a syntax error, fix the code',
    '5. If the error is a runtime error, fix the logic',
    '6. Test that your fix works if possible',
    '',
    'When done, create .fix-complete in the project root:',
    '{"status":"fixed","summary":"What was fixed","files_changed":["list"]}',
    '',
    'If you CANNOT fix the issue, create .fix-complete with:',
    '{"status":"failed","reason":"Why it cannot be fixed"}',
  ].join('\n');

  const run = runClaudeSilent({
    id: 'fix-' + sourceCardId + '-' + attempts.count,
    cardId: sourceCardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: fixLog,
  });

  buildPids.set(sourceCardId, run.pid);

  let pollCount = 0;
  const maxPoll = Math.round(runtime.selfHealTimeoutMins * 60000 / runtime.pollIntervalMs);

  const fixInterval = setInterval(function() {
    pollCount++;
    try {
      if (fs.existsSync(fixFile)) {
        clearInterval(fixInterval);
        activeFixes.delete(sourceCardId);

        const content = fs.readFileSync(fixFile, 'utf-8').trim();
        try {
          const data = JSON.parse(content);
          try { fs.appendFileSync(fixLog, '\n[SELF-HEAL] Result: ' + data.status + '\n'); } catch (_) {}

          if (data.status === 'fixed') {
            try { fs.appendFileSync(fixLog, '[SELF-HEAL] Fixed: ' + (data.summary || 'No summary') + '\n'); } catch (_) {}
            broadcast('toast', { message: 'Self-healed: ' + card.title + ' — ' + (data.summary || 'Fixed'), type: 'success' });
            sendWebhook('self-heal-success', { cardId: sourceCardId, summary: data.summary });
            fixAttempts.delete(sourceCardId);
          } else {
            try { fs.appendFileSync(fixLog, '[SELF-HEAL] Failed: ' + (data.reason || 'Unknown') + '\n'); } catch (_) {}
            broadcast('toast', { message: 'Self-heal failed: ' + (data.reason || 'Unknown'), type: 'error' });
          }
        } catch (_) {
          try { fs.appendFileSync(fixLog, '\n[SELF-HEAL] Invalid JSON in .fix-complete\n'); } catch (_) {}
        }
        try { fs.unlinkSync(fixFile); } catch (_) {}
      }

      if (pollCount >= maxPoll) {
        clearInterval(fixInterval);
        activeFixes.delete(sourceCardId);
        try { fs.appendFileSync(fixLog, '\n[SELF-HEAL] Timed out after 10 minutes\n'); } catch (_) {}
        broadcast('toast', { message: 'Self-heal timed out for: ' + card.title, type: 'error' });
      }
    } catch (err) {
      log.error({ err: err.message }, 'selfHeal poll error');
    }
  }, runtime.pollIntervalMs);

  return { status: 'fixing', attempt: attempts.count };
}

function getFixAttempts(sourceCardId) {
  return fixAttempts.get(sourceCardId) || { count: 0, lastAttempt: 0 };
}

// --- Retry with Feedback ---

function retryWithFeedback(cardId, feedback) {
  const card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');

  // Concurrency check — respect MAX_CONCURRENT_BUILDS limit (was previously bypassed)
  if (activeBuilds.size >= runtime.maxConcurrentBuilds) {
    throw new Error('Build slots full (' + activeBuilds.size + '/' + runtime.maxConcurrentBuilds + '). Wait for a build to finish or increase MAX_CONCURRENT_BUILDS.');
  }

  const projectPath = card.project_path;

  // Block if another card is already building in this project
  const existingBuild = activeBuilds.get(projectPath);
  if (existingBuild && existingBuild !== cardId) {
    throw new Error('Another build is active in this project folder. Wait for card #' + existingBuild + ' to finish.');
  }

  snapshot.take(cardId, projectPath);

  cards.move(cardId, 'working');
  cards.setStatus(cardId, 'building');
  cards.setReviewData(cardId, 0, '');
  reviewFixCount.delete(cardId);

  const buildLog = logPath(cardId, 'build');
  const { sanitizeForFile } = require('./claude-runner');
  const safeFeedback = sanitizeForFile(feedback);
  const header = '\n\n[' + new Date().toISOString() + '] Retry with feedback\nFeedback: ' + safeFeedback + '\n---\n';
  try { fs.appendFileSync(buildLog, header); } catch (_) { fs.writeFileSync(buildLog, header); }

  const completionFile = path.join(projectPath, '.task-complete');
  try { fs.unlinkSync(completionFile); } catch (_) {}

  const prompt = 'The previous work on this project has been reviewed and needs specific changes. '
    + 'Keep ALL existing work — do NOT start from scratch or undo anything unless specifically requested. '
    + 'Apply ONLY these changes:\n\n'
    + feedback + '\n\n'
    + 'Read the existing code first to understand what was built. Then make the requested changes. '
    + 'When fully done, create .task-complete with: {"status":"complete","summary":"What was changed","files_changed":["list"]}';

  activeBuilds.set(projectPath, cardId);
  trackPhase(cardId, 'retry', 'start');

  const run = runClaudeSilent({
    id: 'retry-' + cardId + '-' + Date.now(),
    cardId: cardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: buildLog,
  });

  buildPids.set(cardId, run.pid);

  broadcast('card-updated', cards.get(cardId));
  setActivity(cardId, 'build', 'Retrying with feedback...');
  sendWebhook('retry-started', { cardId: cardId, title: card.title, feedback: feedback });

  pollForCompletion(cardId, projectPath);

  return { success: true };
}

// --- Init ---

function preflightChecks() {
  const issues = [];
  const execFileSync = require('child_process').execFileSync;

  [RUNTIME_DIR, LOGS_DIR].forEach(function(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const testFile = path.join(dir, '.preflight-test');
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
    } catch (e) {
      issues.push('Cannot write to ' + dir + ': ' + e.message);
    }
  });

  if (!IS_WIN && !fs.existsSync(PROJECTS_ROOT)) {
    try { fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); }
    catch (e) { issues.push('Cannot create projects dir ' + PROJECTS_ROOT + ': ' + e.message); }
  }

  try {
    execFileSync('claude', ['--version'], { timeout: 10000, stdio: 'pipe' });
  } catch (_) {
    issues.push('Claude CLI not found in PATH. Install: https://docs.anthropic.com/en/docs/claude-code');
  }

  try {
    execFileSync('code', ['--version'], { timeout: 5000, stdio: 'pipe' });
  } catch (_) {
    log.info('VS Code CLI not found — "Open in VSCode" will not work');
  }

  if (IS_MAC) {
    const testScript = path.join(RUNTIME_DIR, '.preflight-exec-test.sh');
    try {
      fs.writeFileSync(testScript, '#!/bin/bash\necho ok', { mode: 0o755 });
      execFileSync('bash', [testScript], { timeout: 5000, stdio: 'pipe' });
      fs.unlinkSync(testScript);
    } catch (e) {
      issues.push('Cannot run shell scripts: ' + e.message);
    }
  }

  if (!IS_WIN && !IS_MAC) {
    try {
      execFileSync('which', ['xdg-open'], { timeout: 3000, stdio: 'pipe' });
    } catch (_) {
      log.info('xdg-open not found — browser auto-open disabled');
    }
  }

  if (issues.length > 0) {
    log.warn({ issues }, 'Preflight issues detected');
  } else {
    log.info('Preflight all checks passed (' + process.platform + ')');
  }
}

function init() {
  preflightChecks();
  // Crash recovery (recoverOrphanedCards) runs from server.js after full startup

  usageSvc.fetchClaudeUsage(true).then(function(data) {
    if (data) {
      log.info({ session: data.five_hour ? data.five_hour.utilization : '?', weekly: data.seven_day ? data.seven_day.utilization : '?' }, 'Claude Max usage');
      broadcast('usage-update', usageSvc.getUsageStats());
    } else {
      log.warn('Could not fetch Claude Max usage (check ~/.claude/.credentials.json)');
    }
  });
  setInterval(function() {
    usageSvc.fetchClaudeUsage(true).then(function(data) {
      if (data) {
        broadcast('usage-update', usageSvc.getUsageStats());
        usageSvc.checkUsageLimits(getPipelineState());
      }
    });
  }, runtime.usageCacheTtlMins * 60 * 1000);

  // Initialize auto-discovery for single-project mode
  const autoDiscover = require('./auto-discover');
  autoDiscover.init();

  if (runtime.mode === 'single-project') {
    log.info('Mode: SINGLE-PROJECT — autonomous pipeline active');
  } else {
    log.info('Mode: GLOBAL — multi-project manual mode');
  }
}

// --- Crash Recovery ---
// On server restart, cards may be stuck in transient states (building, reviewing, etc.)
// because the processes that owned them are gone. Reset them to safe states.
function recoverOrphanedCards() {
  const allCards = cards.getAll();
  let recovered = 0;
  let hasRateLimited = false;

  for (let i = 0; i < allCards.length; i++) {
    const c = allCards[i];
    const st = c.status;

    if (st === 'building') {
      cards.setStatus(c.id, 'interrupted');
      cards.move(c.id, 'todo');
      log.info({ cardId: c.id, title: c.title, from: 'building' }, 'Crash recovery: reset building card to interrupted');
      recovered++;
    } else if (st === 'reviewing') {
      cards.setStatus(c.id, 'idle');
      cards.move(c.id, 'review');
      log.info({ cardId: c.id, title: c.title, from: 'reviewing' }, 'Crash recovery: reset reviewing card to idle in review');
      recovered++;
    } else if (st === 'fixing') {
      cards.setStatus(c.id, 'fix-interrupted');
      cards.move(c.id, 'todo');
      log.info({ cardId: c.id, title: c.title, from: 'fixing' }, 'Crash recovery: reset fixing card to fix-interrupted');
      recovered++;
    } else if (st === 'brainstorming' || st === 'brainstorm-queued') {
      cards.setStatus(c.id, 'frozen');
      // stays in brainstorm column — no move needed
      log.info({ cardId: c.id, title: c.title, from: st }, 'Crash recovery: froze orphaned brainstorm card');
      recovered++;
    } else if (st === 'queued') {
      // Queue is in-memory; queued cards become zombies after crash
      cards.setStatus(c.id, 'idle');
      // Keep in current column (todo) — ready for manual re-queue
      log.info({ cardId: c.id, title: c.title, from: 'queued' }, 'Crash recovery: reset queued card to idle');
      recovered++;
    } else if (st === 'rate-limited') {
      // Rate-limited cards: keep status so recovery poller can re-queue them.
      // But check if usage has reset — if so, recover immediately.
      log.info({ cardId: c.id, title: c.title, column: c.column_name }, 'Crash recovery: found rate-limited card — will recover when usage resets');
      recovered++;
      hasRateLimited = true;
    }
  }

  // If any rate-limited cards found, start the recovery poller
  if (hasRateLimited) {
    log.info('Starting recovery poller for rate-limited cards from previous crash');
    startRecoveryPoller();
  }

  // Autonomous mode: re-enqueue recovered cards so pipeline resumes automatically
  if (recovered > 0 && runtime.mode === 'single-project' && runtime.autoPromoteBrainstorm) {
    setTimeout(function() {
      const toRequeue = cards.getAll();
      for (let ri = 0; ri < toRequeue.length; ri++) {
        const rc = toRequeue[ri];
        // Re-enqueue interrupted/idle cards in todo that have specs
        // Skip cards explicitly rejected by a human — they need manual retry
        if (rc.column_name === 'todo' && rc.spec && (rc.status === 'interrupted' || rc.status === 'idle' || rc.status === 'fix-interrupted') && rc.approved_by !== 'human-rejected') {
          cards.setStatus(rc.id, 'idle');
          try { enqueue(rc.id, 0); } catch (_) {}
          log.info({ cardId: rc.id, title: rc.title }, 'Autonomous crash recovery: re-enqueued');
        }
        // Re-trigger review for idle cards stuck in review column
        if (rc.column_name === 'review' && rc.status === 'idle') {
          try { require('./review').autoReview(rc.id); } catch (_) {}
          log.info({ cardId: rc.id, title: rc.title }, 'Autonomous crash recovery: re-reviewing');
        }
        // Re-brainstorm frozen cards
        if (rc.status === 'frozen' && rc.column_name === 'brainstorm') {
          cards.setStatus(rc.id, 'idle');
          try { require('./brainstorm').brainstorm(rc.id); } catch (_) {}
          log.info({ cardId: rc.id, title: rc.title }, 'Autonomous crash recovery: re-brainstorming');
        }
      }
    }, 5000); // Delay to let server fully initialize
  }

  return recovered;
}

module.exports = {
  init: init,
  // Pipeline control
  setPaused: setPaused,
  isPaused: isPaused,
  killAll: killAll,
  stopCard: stopCard,
  // Queue
  enqueue: enqueue,
  dequeue: dequeue,
  startWork: startWork,
  getQueueInfo: getQueueInfo,
  processQueue: processQueue,
  releaseProjectLock: releaseProjectLock,
  // Activity
  setActivity: setActivity,
  clearActivity: clearActivity,
  getActivities: getActivities,
  trackPhase: trackPhase,
  trackPid: trackPid,
  // Cascade
  cascadeRevert: cascadeRevert,
  checkUnblock: checkUnblock,
  // Review fix state
  getReviewFixCount: getReviewFixCount,
  setReviewFixCount: setReviewFixCount,
  deleteReviewFixCount: deleteReviewFixCount,
  // Self-heal
  selfHeal: selfHeal,
  getFixAttempts: getFixAttempts,
  // Retry
  retryWithFeedback: retryWithFeedback,
  // State
  getPipelineState: getPipelineState,
  activePollers: activePollers,
  // Crash recovery
  recoverOrphanedCards: recoverOrphanedCards,
  // Rate-limit recovery
  handleRateLimitDetected: handleRateLimitDetected,
  startRecoveryPoller: startRecoveryPoller,
  stopRecoveryPoller: stopRecoveryPoller,
};
