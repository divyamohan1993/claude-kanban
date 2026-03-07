const fs = require('fs');
const path = require('path');
const { IS_WIN, IS_MAC, PROJECTS_ROOT, LOGS_DIR, RUNTIME_DIR, runtime } = require('../config');
const { cards, sessions } = require('../db');
const { broadcast } = require('../lib/broadcast');
const { killProcess } = require('../lib/process-manager');
const { logPath, suggestName, sendWebhook } = require('../lib/helpers');
const { runClaudeSilent } = require('./claude-runner');
const snapshot = require('./snapshot');
const usageSvc = require('./usage');

// Ensure dirs exist
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });

// --- Shared Pipeline State ---
var activePollers = new Map();   // cardId -> interval
var buildPids = new Map();       // cardId -> pid
var workQueue = [];              // [{cardId, priority, projectPath, enqueuedAt}]
var activeBuilds = new Map();    // projectPath -> cardId
var pipelinePaused = false;
var activeFixes = new Set();     // sourceCardId set (self-heal)
var fixAttempts = new Map();     // sourceCardId -> {count, lastAttempt}
var reviewFixCount = new Map();  // cardId -> fix attempt count
var cardActivity = new Map();    // cardId -> {detail, step, timestamp}

// --- State Accessors (for other services) ---

function getPipelineState() {
  return {
    paused: pipelinePaused,
    activeCount: activeBuilds.size,
    queueLength: workQueue.length,
    fixCount: activeFixes.size,
    pollerCount: activePollers.size,
    pause: function() { pipelinePaused = true; broadcast('pipeline-state', { paused: true }); },
  };
}

function trackPid(cardId, pid) { if (pid) buildPids.set(cardId, pid); }
function getReviewFixCount(cardId) { return reviewFixCount.get(cardId) || 0; }
function setReviewFixCount(cardId, count) { reviewFixCount.set(cardId, count); }
function deleteReviewFixCount(cardId) { reviewFixCount.delete(cardId); }

// --- Activity Tracking ---

function setActivity(cardId, step, detail) {
  var entry = { cardId: cardId, step: step, detail: detail, timestamp: Date.now() };
  cardActivity.set(cardId, entry);
  broadcast('card-activity', entry);
}

function clearActivity(cardId) {
  cardActivity.delete(cardId);
  broadcast('card-activity', { cardId: cardId, step: null, detail: null, timestamp: Date.now() });
}

function getActivities() {
  var result = {};
  for (var entry of cardActivity) {
    result[entry[0]] = entry[1];
  }
  return result;
}

// --- Duration Tracking ---

function trackPhase(cardId, phase, action) {
  var card = cards.get(cardId);
  if (!card) return;
  var durations = {};
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

function setPaused(paused) {
  pipelinePaused = !!paused;
  broadcast('pipeline-state', { paused: pipelinePaused });
  sendWebhook('pipeline-' + (pipelinePaused ? 'paused' : 'resumed'), {});
  if (!pipelinePaused) {
    // Lazy requires to avoid circular deps
    var brainstormSvc = require('./brainstorm');
    var reviewSvc = require('./review');

    var allCards = cards.getAll();
    // Restart fix-interrupted cards at top priority
    for (var i = 0; i < allCards.length; i++) {
      var c = allCards[i];
      if (c.status === 'fix-interrupted' && c.column_name === 'todo') {
        try {
          var reviewData = c.review_data ? JSON.parse(c.review_data) : null;
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
      }
    }
    // Restart frozen brainstorm cards
    for (var j = 0; j < allCards.length; j++) {
      if (allCards[j].status === 'frozen' && allCards[j].column_name === 'brainstorm') {
        try { brainstormSvc.brainstorm(allCards[j].id); } catch (_) {}
      }
    }
    processQueue();
  }
}

function isPaused() { return pipelinePaused; }

// --- Kill All ---

function killAll() {
  pipelinePaused = true;
  var killed = [];

  // 1. Kill active builds
  for (var entry of activeBuilds) {
    var projectPath = entry[0], cardId = entry[1];
    var pid = buildPids.get(cardId);
    if (pid) { killProcess(pid); buildPids.delete(cardId); }
    var poller = activePollers.get(cardId);
    if (poller) { clearInterval(poller); activePollers.delete(cardId); }
    var card = cards.get(cardId);
    cards.setStatus(cardId, 'interrupted');
    cards.move(cardId, 'todo');
    setActivity(cardId, 'queue', 'Killed by master kill switch');
    broadcast('card-updated', cards.get(cardId));
    killed.push({ id: cardId, title: card ? card.title : '?', phase: 'build' });
  }
  activeBuilds.clear();

  // 2. Freeze brainstorming cards
  var allCards = cards.getAll();
  for (var ci = 0; ci < allCards.length; ci++) {
    var c = allCards[ci];
    if (c.status === 'brainstorming') {
      var bPid = buildPids.get(c.id);
      if (bPid) { killProcess(bPid); buildPids.delete(c.id); }
      cards.setStatus(c.id, 'frozen');
      setActivity(c.id, 'spec', 'Frozen — will restart on resume');
      broadcast('card-updated', cards.get(c.id));
      killed.push({ id: c.id, title: c.title, phase: 'brainstorm' });
    }
  }

  // 3. Kill fixing processes — preserve review findings
  for (var fi = 0; fi < allCards.length; fi++) {
    var fc = allCards[fi];
    if (fc.status === 'fixing') {
      var fPid = buildPids.get(fc.id);
      if (fPid) { killProcess(fPid); buildPids.delete(fc.id); }
      var fPoller = activePollers.get(fc.id);
      if (fPoller) { clearInterval(fPoller); activePollers.delete(fc.id); }
      cards.setStatus(fc.id, 'fix-interrupted');
      cards.move(fc.id, 'todo');
      setActivity(fc.id, 'queue', 'Fix interrupted — will resume at top priority');
      broadcast('card-updated', cards.get(fc.id));
      killed.push({ id: fc.id, title: fc.title, phase: 'fix' });
    }
  }
  activeFixes.clear();

  // 4. Kill review processes
  for (var ri = 0; ri < allCards.length; ri++) {
    var rc = allCards[ri];
    if (rc.column_name === 'review' && rc.status !== 'fix-interrupted') {
      var rPid = buildPids.get(rc.id);
      if (rPid) { killProcess(rPid); buildPids.delete(rc.id); }
      var rPoller = activePollers.get(rc.id);
      if (rPoller) { clearInterval(rPoller); activePollers.delete(rc.id); }
      cards.setStatus(rc.id, 'interrupted');
      cards.move(rc.id, 'todo');
      setActivity(rc.id, 'queue', 'Killed by master kill switch');
      broadcast('card-updated', cards.get(rc.id));
      killed.push({ id: rc.id, title: rc.title, phase: 'review' });
    }
  }

  // 5. Clear orphans
  for (var pollerEntry of activePollers) { clearInterval(pollerEntry[1]); }
  activePollers.clear();
  for (var pidEntry of buildPids) { killProcess(pidEntry[1]); }
  buildPids.clear();

  // 6. Drain queue
  while (workQueue.length > 0) {
    var qi = workQueue.pop();
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
  var card = cards.get(cardId);
  if (!card) throw new Error('Card not found');

  var result = dequeue(cardId);

  var poller = activePollers.get(cardId);
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
  var card = cards.get(cardId);
  if (!card) throw new Error('Card not found');
  if (!card.spec) throw new Error('No spec — run brainstorm first');

  if (card.depends_on) {
    var deps = card.depends_on.split(',').map(function(d) { return Number(d.trim()); }).filter(Boolean);
    for (var di = 0; di < deps.length; di++) {
      var depCard = cards.get(deps[di]);
      if (depCard && depCard.column_name !== 'done' && depCard.column_name !== 'archive') {
        throw new Error('Blocked by card #' + deps[di] + ' (' + depCard.title + ')');
      }
    }
  }

  var projectPath = card.project_path;
  if (!projectPath) {
    projectPath = path.join(PROJECTS_ROOT, suggestName(card.title));
    cards.setProjectPath(cardId, projectPath);
  }

  for (var entry of activeBuilds) {
    if (entry[1] === cardId) return { status: 'already-building' };
  }

  var existing = workQueue.find(function(q) { return q.cardId === cardId; });
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
  var idx = workQueue.findIndex(function(q) { return q.cardId === cardId; });
  if (idx >= 0) {
    workQueue.splice(idx, 1);
    broadcastQueuePositions();
    return { removed: true };
  }

  for (var entry of activeBuilds) {
    if (entry[1] === cardId) {
      activeBuilds.delete(entry[0]);
      var poller = activePollers.get(cardId);
      if (poller) { clearInterval(poller); activePollers.delete(cardId); }
      var pid = buildPids.get(cardId);
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
  for (var i = 0; i < workQueue.length; i++) {
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
  var card = cards.get(cardId);
  if (!card) return;
  var projectPath = card.project_path;
  if (projectPath && activeBuilds.get(projectPath) === cardId) {
    activeBuilds.delete(projectPath);
    processQueue();
  }
}

// --- Cascade Revert ---

function cascadeRevert(revertedCardId) {
  var allCards = cards.getAll();
  var affected = [];

  for (var c of allCards) {
    if (!c.depends_on) continue;
    var deps = c.depends_on.split(',').map(function(d) { return Number(d.trim()); }).filter(Boolean);
    if (!deps.includes(revertedCardId)) continue;

    var wasActive = false;
    if (c.status === 'building' || c.status === 'reviewing' || c.status === 'fixing' || c.status === 'queued') {
      var dqResult = dequeue(c.id);
      wasActive = dqResult.wasBuilding || dqResult.removed;
      var reviewPoller = activePollers.get(c.id);
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
  var allCards = cards.getAll();
  var unblocked = [];

  for (var c of allCards) {
    if (c.status !== 'blocked') continue;
    if (!c.depends_on) {
      cards.setStatus(c.id, 'idle');
      clearActivity(c.id);
      broadcast('card-updated', cards.get(c.id));
      unblocked.push(c.id);
      continue;
    }

    var deps = c.depends_on.split(',').map(function(d) { return Number(d.trim()); }).filter(Boolean);
    var allSatisfied = true;
    for (var di = 0; di < deps.length; di++) {
      var depCard = cards.get(deps[di]);
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
    }
  }

  return unblocked;
}

// --- Process Queue ---

function processQueue() {
  if (pipelinePaused) return;
  var limits = usageSvc.checkUsageLimits(getPipelineState());
  if (!limits.allowed) return;
  if (activeBuilds.size >= runtime.maxConcurrentBuilds) return;

  for (var i = 0; i < workQueue.length; i++) {
    var item = workQueue[i];
    if (activeBuilds.has(item.projectPath)) continue;

    var card = cards.get(item.cardId);
    if (card && card.depends_on) {
      var deps = card.depends_on.split(',').map(function(d) { return Number(d.trim()); }).filter(Boolean);
      var blocked = false;
      for (var di = 0; di < deps.length; di++) {
        var depCard = cards.get(deps[di]);
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
      console.error('executeWork failed for card', item.cardId, ':', err.message);
      cards.setStatus(item.cardId, 'idle');
      cards.move(item.cardId, 'todo');
      broadcast('card-updated', cards.get(item.cardId));
    }
    broadcastQueuePositions();
    if (activeBuilds.size >= runtime.maxConcurrentBuilds) return;
    i--;
  }
}

// --- Execute Work ---

function executeWork(cardId, projectPath) {
  var card = cards.get(cardId);
  if (!card) return;

  var isExisting = projectPath && fs.existsSync(projectPath);

  if (card.column_name !== 'working') {
    cards.move(cardId, 'working');
    broadcast('card-updated', cards.get(cardId));
  }
  activeBuilds.set(projectPath, cardId);
  setActivity(cardId, 'snapshot', 'Taking file snapshot...');
  trackPhase(cardId, 'build', 'start');

  var completionFile = path.join(projectPath, '.task-complete');
  try { fs.unlinkSync(completionFile); } catch (_) {}

  var snapInfo;
  try {
    snapInfo = snapshot.take(cardId, projectPath);
  } catch (err) {
    console.error('Snapshot failed for card', cardId, err.message);
    activeBuilds.delete(projectPath);
    clearActivity(cardId);
    throw err;
  }

  if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });

  setActivity(cardId, 'snapshot', 'Snapshot taken (' + snapInfo.fileCount + ' files)');

  // Build CLAUDE.md
  var claudeParts = ['# Task: ' + card.title, ''];
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

  var cp = usageSvc.getCustomPrompts();
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

  fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), claudeParts.join('\n'));
  setActivity(cardId, 'build', 'CLAUDE.md written — launching Claude...');

  var log = logPath(cardId, 'build');
  var header = '[' + new Date().toISOString() + '] Build started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\n'
    + 'Mode: ' + (isExisting ? 'EXISTING' : 'NEW') + '\nSnapshot: ' + snapInfo.fileCount + ' files\n---\n';
  fs.writeFileSync(log, header);

  var buildPrompt = 'Read CLAUDE.md and complete the task as specified. You are an autonomous orchestrator with FULL access to all tools — use subagents, agent teams, web search, file operations, terminal commands — whatever it takes. Maximize parallelism. Think deeply. Deliver production-quality work. When fully done, create .task-complete file as instructed in CLAUDE.md.';

  var run = runClaudeSilent({
    id: 'build-' + cardId,
    cardId: cardId,
    cwd: projectPath,
    prompt: buildPrompt,
    stdoutFile: null,
    logFile: log,
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
  var completionFile = path.join(projectPath, '.task-complete');
  var log = logPath(cardId, 'build');
  var pollCount = 0;

  var interval = setInterval(function() {
    pollCount++;
    var needsQueueProcess = false;
    try {
      var card = cards.get(cardId);
      if (!card || card.column_name !== 'working') {
        clearInterval(interval);
        activePollers.delete(cardId);
        activeBuilds.delete(projectPath);
        buildPids.delete(cardId);
        needsQueueProcess = true;
        return;
      }

      var isIdle = false;
      var idleMinutes = 0;
      try {
        var logStat = fs.statSync(log);
        var msSinceWrite = Date.now() - logStat.mtimeMs;
        idleMinutes = Math.round(msSinceWrite / 60000);
        isIdle = msSinceWrite > runtime.idleTimeoutMs;
      } catch (_) {
        isIdle = pollCount >= runtime.buildTimeoutPolls;
        idleMinutes = Math.round(pollCount * 5 / 60);
      }
      var hardTimeout = pollCount >= runtime.buildTimeoutPolls * 4;

      if (isIdle || hardTimeout) {
        var reason = hardTimeout ? 'Hard limit (' + Math.round(pollCount * 5 / 60) + ' min)' : 'Idle for ' + idleMinutes + ' min (no log activity)';
        clearInterval(interval);
        activePollers.delete(cardId);
        activeBuilds.delete(projectPath);
        trackPhase(cardId, 'build', 'end');
        var pid = buildPids.get(cardId);
        if (pid) { killProcess(pid); buildPids.delete(cardId); }
        cards.setStatus(cardId, 'interrupted');
        broadcast('card-updated', cards.get(cardId));
        setActivity(cardId, 'build', 'TIMEOUT — ' + reason);
        try { fs.appendFileSync(log, '\n---\n[' + new Date().toISOString() + '] TIMEOUT — ' + reason + '\n'); } catch (_) {}
        broadcast('toast', { message: 'Build timed out (' + reason + '): ' + card.title, type: 'error' });
        sendWebhook('build-timeout', { cardId: cardId, title: card.title, reason: reason });
        needsQueueProcess = true;
        return;
      }

      if (fs.existsSync(completionFile)) {
        clearInterval(interval);
        activePollers.delete(cardId);
        buildPids.delete(cardId);
        trackPhase(cardId, 'build', 'end');

        var content = fs.readFileSync(completionFile, 'utf-8');
        cards.setSessionLog(cardId, content);
        cards.setStatus(cardId, 'idle');
        cards.move(cardId, 'review');
        setActivity(cardId, 'review', 'Build complete — starting AI review...');
        broadcast('card-updated', cards.get(cardId));
        sendWebhook('build-complete', { cardId: cardId, title: card.title });

        try { fs.appendFileSync(log, '\n---\n[' + new Date().toISOString() + '] Build completed\n' + content + '\n'); } catch (_) {}

        // Lazy require review to avoid circular dep
        try {
          var reviewSvc = require('./review');
          reviewSvc.autoReview(cardId);
        } catch (reviewErr) {
          console.error('autoReview failed for card', cardId, ':', reviewErr.message);
          try { fs.appendFileSync(log, '\n[ERROR] autoReview failed: ' + reviewErr.message + '\n'); } catch (_) {}
          cards.setStatus(cardId, 'idle');
          broadcast('card-updated', cards.get(cardId));
          broadcast('toast', { message: 'AI Review failed to start: ' + reviewErr.message, type: 'error' });
        }
      }
    } catch (err) {
      console.error('pollForCompletion error for card', cardId, ':', err.message);
    } finally {
      if (needsQueueProcess) {
        try { processQueue(); } catch (e) { console.error('processQueue error:', e.message); }
      }
    }
  }, 5000);

  activePollers.set(cardId, interval);
}

// --- Self-Healing ---

function selfHeal(sourceCardId, errors, sourceLogFile) {
  if (activeFixes.has(sourceCardId)) return { status: 'already-fixing' };

  var attempts = fixAttempts.get(sourceCardId) || { count: 0, lastAttempt: 0 };
  if (attempts.count >= runtime.maxFixAttempts) return { status: 'max-attempts', count: attempts.count };

  var card = cards.get(sourceCardId);
  if (!card || !card.project_path) return { status: 'no-project' };
  if (!fs.existsSync(card.project_path)) return { status: 'project-missing' };
  if (activeBuilds.has(card.project_path)) return { status: 'build-active' };

  activeFixes.add(sourceCardId);
  attempts.count++;
  attempts.lastAttempt = Date.now();
  fixAttempts.set(sourceCardId, attempts);

  var projectPath = card.project_path;
  var fixLog = logPath(sourceCardId, 'fix-' + attempts.count);
  var fixFile = path.join(projectPath, '.fix-complete');

  try { fs.unlinkSync(fixFile); } catch (_) {}

  var header = '[' + new Date().toISOString() + '] Self-heal attempt ' + attempts.count + '/' + runtime.maxFixAttempts + '\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\nErrors: ' + errors.length + '\n---\n';
  fs.writeFileSync(fixLog, header);

  var logContext = '';
  try {
    if (sourceLogFile && fs.existsSync(sourceLogFile)) {
      logContext = fs.readFileSync(sourceLogFile, 'utf-8').slice(-3000);
    }
  } catch (_) {}

  var prompt = [
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

  var run = runClaudeSilent({
    id: 'fix-' + sourceCardId + '-' + attempts.count,
    cardId: sourceCardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: fixLog,
  });

  buildPids.set(sourceCardId, run.pid);

  var pollCount = 0;
  var maxPoll = 120;

  var fixInterval = setInterval(function() {
    pollCount++;
    try {
      if (fs.existsSync(fixFile)) {
        clearInterval(fixInterval);
        activeFixes.delete(sourceCardId);

        var content = fs.readFileSync(fixFile, 'utf-8').trim();
        try {
          var data = JSON.parse(content);
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
      console.error('selfHeal poll error:', err.message);
    }
  }, 5000);

  return { status: 'fixing', attempt: attempts.count };
}

function getFixAttempts(sourceCardId) {
  return fixAttempts.get(sourceCardId) || { count: 0, lastAttempt: 0 };
}

// --- Retry with Feedback ---

function retryWithFeedback(cardId, feedback) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');

  var projectPath = card.project_path;

  snapshot.take(cardId, projectPath);

  cards.move(cardId, 'working');
  cards.setStatus(cardId, 'building');
  cards.setReviewData(cardId, 0, '');
  reviewFixCount.delete(cardId);

  var log = logPath(cardId, 'build');
  var header = '\n\n[' + new Date().toISOString() + '] Retry with feedback\nFeedback: ' + feedback + '\n---\n';
  try { fs.appendFileSync(log, header); } catch (_) { fs.writeFileSync(log, header); }

  var completionFile = path.join(projectPath, '.task-complete');
  try { fs.unlinkSync(completionFile); } catch (_) {}

  var prompt = 'The previous work on this project has been reviewed and needs specific changes. '
    + 'Keep ALL existing work — do NOT start from scratch or undo anything unless specifically requested. '
    + 'Apply ONLY these changes:\n\n'
    + feedback + '\n\n'
    + 'Read the existing code first to understand what was built. Then make the requested changes. '
    + 'When fully done, create .task-complete with: {"status":"complete","summary":"What was changed","files_changed":["list"]}';

  activeBuilds.set(projectPath, cardId);
  trackPhase(cardId, 'retry', 'start');

  var run = runClaudeSilent({
    id: 'retry-' + cardId + '-' + Date.now(),
    cardId: cardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: log,
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
  var issues = [];
  var execFileSync = require('child_process').execFileSync;

  [RUNTIME_DIR, LOGS_DIR].forEach(function(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      var testFile = path.join(dir, '.preflight-test');
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
    console.log('  [preflight] VS Code CLI not found — "Open in VSCode" will not work');
  }

  if (IS_MAC) {
    var testScript = path.join(RUNTIME_DIR, '.preflight-exec-test.sh');
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
      console.log('  [preflight] xdg-open not found — browser auto-open disabled');
    }
  }

  if (issues.length > 0) {
    console.log('\n  [preflight] Issues detected:');
    issues.forEach(function(i) { console.log('    - ' + i); });
    console.log('');
  } else {
    console.log('  [preflight] All checks passed (' + process.platform + ')');
  }
}

function resetStuckCards() {
  var all = cards.getAll();
  for (var i = 0; i < all.length; i++) {
    var c = all[i];
    if (c.status === 'queued' || c.status === 'building') {
      cards.setStatus(c.id, 'idle');
      if (c.column_name === 'working') cards.move(c.id, 'todo');
      broadcast('card-updated', cards.get(c.id));
    } else if (c.status === 'reviewing' || c.status === 'fixing') {
      cards.setStatus(c.id, 'idle');
      broadcast('card-updated', cards.get(c.id));
    }
  }
}

function init() {
  preflightChecks();
  resetStuckCards();

  usageSvc.fetchClaudeUsage(true).then(function(data) {
    if (data) {
      console.log('  [usage] Claude Max: session ' + (data.five_hour ? data.five_hour.utilization : '?') + '%, weekly ' + (data.seven_day ? data.seven_day.utilization : '?') + '%');
      broadcast('usage-update', usageSvc.getUsageStats());
    } else {
      console.log('  [usage] Could not fetch Claude Max usage (check ~/.claude/.credentials.json)');
    }
  });
  setInterval(function() {
    usageSvc.fetchClaudeUsage(true).then(function(data) {
      if (data) {
        broadcast('usage-update', usageSvc.getUsageStats());
        usageSvc.checkUsageLimits(getPipelineState());
      }
    });
  }, usageSvc.USAGE_CACHE_TTL);
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
};
