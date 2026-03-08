const express = require('express');
const fs = require('fs');
const path = require('path');
const { cards, sessions, auditLog, VALID_COLUMNS } = require('../db');
const { broadcast, sseClients } = require('../lib/broadcast');
const { LOGS_DIR, PROJECTS_ROOT, runtime } = require('../config');
const { optionalAuth, requireAuth } = require('../sso');
const { log } = require('../lib/logger');
const pipeline = require('../services/pipeline');
const brainstormSvc = require('../services/brainstorm');
const support = require('../services/support');
const git = require('../services/git');
const snapshot = require('../services/snapshot');
const usageSvc = require('../services/usage');
const autoDiscover = require('../services/auto-discover');
const intelligence = require('../services/intelligence');

const router = express.Router();

// --- Security: Global card count cap — prevents DB spam via automated card creation ---
const MAX_TOTAL_CARDS = 500;
function checkCardLimit() {
  const count = cards.getAll().length + cards.getArchived().length;
  if (count >= MAX_TOTAL_CARDS) {
    return 'Card limit reached (' + MAX_TOTAL_CARDS + '). Archive or delete old cards first.';
  }
  return null;
}

// --- Security: Allowed log types (C1/C2 path traversal fix) ---
const ALLOWED_LOG_TYPES = ['build', 'brainstorm', 'review', 'review-fix', 'fix-1', 'fix-2', 'fix-3'];

function isAllowedLogType(type) {
  return typeof type === 'string' && ALLOWED_LOG_TYPES.includes(type);
}

// --- Security: Validate project_path under PROJECTS_ROOT (C3/C5 fix) ---
const resolvedProjectsRoot = path.resolve(PROJECTS_ROOT);
function isPathUnderProjectsRoot(p) {
  const resolved = path.resolve(p);
  return resolved === resolvedProjectsRoot || resolved.startsWith(resolvedProjectsRoot + path.sep);
}

// --- SSE — open for public monitoring (rate-limited + SSE guard in server.js) ---
router.get('/api/events', optionalAuth, function(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', function() { sseClients.delete(res); });
});

// =============================================================================
// SERVER-DRIVEN CARD ACTIONS
// =============================================================================
// The server decides what actions are available for each card.
// Frontend renders buttons based on this array — zero decision-making.

function computeActions(card) {
  let actions = [];
  const col = card.column_name;
  const st = card.status;

  if (st === 'interrupted') {
    actions.push('retry');
    actions.push('re-brainstorm');
    actions.push('reject');
    actions.push('discard');
    return actions;
  }

  switch (col) {
    case 'brainstorm':
      if (runtime.mode !== 'single-project') actions.push('detect-project');
      if (card.project_path && !card.spec) actions.push('brainstorm');
      if (card.project_path && card.spec) actions.push('brainstorm'); // re-brainstorm
      if (card.spec && runtime.mode === 'single-project' && !runtime.autoPromoteBrainstorm) {
        actions.push('promote'); // manual approval: promote brainstorm → decompose → todo
      }
      if (card.spec && runtime.mode !== 'single-project') actions.push('move-to-todo');
      if (st === 'initiative-active') {
        actions = actions.filter(function(a) { return a !== 'brainstorm' && a !== 'move-to-todo' && a !== 'promote'; });
      }
      break;

    case 'todo':
      if (st === 'blocked') {
        actions.push('retry');
        actions.push('discard');
      } else if (st === 'queued') {
        actions.push('cancel-queue');
        actions.push('view-log');
      } else {
        if (card.spec && card.project_path) actions.push('start-work');
        if (card.project_path) actions.push('re-brainstorm');
        if (!card.project_path) actions.push('detect-project');
      }
      break;

    case 'working':
      if (['building', 'brainstorming', 'reviewing', 'fixing'].includes(st)) {
        actions.push('stop');
      }
      actions.push('view-log');
      break;

    case 'review':
      actions.push('approve');
      actions.push('reject');
      actions.push('retry-with-feedback');
      actions.push('diff');
      if (card.review_score > 0) actions.push('view-findings');
      if (st === 'reviewing') actions.push('view-log');
      if (st === 'fixing') actions.push('view-fix-log');
      break;

    case 'done':
      if (card.project_path) {
        actions.push('preview');
        actions.push('diff');
        actions.push('revert');
      }
      actions.push('archive');
      break;

    case 'archive':
      actions.push('unarchive');
      break;
  }

  // Housekeeping — always available at end (except archive/working)
  if (col !== 'archive') {
    if (card.spec && col !== 'working') actions.push('feedback');
    if (card.spec) actions.push('edit-spec');
    actions.push('edit');
    actions.push('delete');
  }

  return actions;
}

// Server-computed display state — frontend renders this, makes zero decisions
function computeDisplay(card, allCards) {
  const display = { badges: [], pipelineStep: null };
  const st = card.status;

  // Status badges — server decides what badge to show
  if (st === 'frozen') display.badges.push({ text: 'Frozen', type: 'blocked' });
  else if (st === 'fix-interrupted') display.badges.push({ text: 'Fix Paused', type: 'warning' });
  else if (st === 'brainstorming') display.badges.push({ text: 'Brainstorming', type: 'brainstorming', spinner: true });
  else if (st === 'queued') {
    const qInfo = pipeline.getQueueInfo();
    let qPos = -1;
    if (qInfo && qInfo.queue) {
      for (let qi = 0; qi < qInfo.queue.length; qi++) {
        if (qInfo.queue[qi].cardId === card.id) { qPos = qInfo.queue[qi].position; break; }
      }
    }
    display.badges.push({ text: 'Queued' + (qPos > 0 ? ' #' + qPos : ''), type: 'queued' });
    display.queuePosition = qPos;
  }
  else if (st === 'building') display.badges.push({ text: 'Building', type: 'building', spinner: true });
  else if (st === 'reviewing') display.badges.push({ text: 'AI Reviewing', type: 'reviewing', spinner: true });
  else if (st === 'fixing') display.badges.push({ text: 'Auto-Fixing', type: 'building', spinner: true });
  else if (st === 'interrupted') display.badges.push({ text: 'Interrupted', type: 'interrupted' });
  else if (st === 'blocked') display.badges.push({ text: 'Blocked', type: 'blocked' });
  else if (card.spec) display.badges.push({ text: 'Has Spec', type: 'has-spec' });

  if (st === 'complete') display.badges.push({ text: 'Complete', type: 'complete' });

  // Dependency blocking — server resolves which deps are unmet
  if (card.depends_on && allCards) {
    const deps = card.depends_on.split(',').filter(Boolean);
    const blockedBy = [];
    for (let d = 0; d < deps.length; d++) {
      const depId = Number(deps[d].trim());
      for (let c = 0; c < allCards.length; c++) {
        if (allCards[c].id === depId && allCards[c].column_name !== 'done' && allCards[c].column_name !== 'archive') {
          blockedBy.push('#' + depId + ' ' + allCards[c].title);
          break;
        }
      }
    }
    if (blockedBy.length > 0) {
      display.badges.push({ text: 'Blocked: ' + blockedBy.join(', '), type: 'blocked' });
    }
  }

  // Review score — server computes display type
  if (card.review_score > 0) {
    display.reviewScore = {
      value: card.review_score,
      type: card.review_score >= 8 ? 'high' : card.review_score >= 5 ? 'mid' : 'low',
    };
  }

  // Approval badge
  if (card.approved_by) {
    display.approval = { by: card.approved_by, type: card.approved_by === 'human' ? 'human' : 'ai' };
  }

  // Parent-child hierarchy info
  if (card.parent_card_id) {
    display.parentCardId = card.parent_card_id;
    let parent = null;
    if (allCards) {
      for (let pi = 0; pi < allCards.length; pi++) {
        if (allCards[pi].id === card.parent_card_id) { parent = allCards[pi]; break; }
      }
    }
    if (parent) display.parentTitle = parent.title;
    display.isSubtask = true;
    display.initiativeId = card.parent_card_id;
    display.badges.push({ text: 'Sub-task', type: 'subtask' });
  }
  if (st === 'initiative-active') {
    const childCount = cards.getByParent(card.id).length;
    const incomplete = cards.countIncompleteChildren(card.id);
    display.isMainIdea = true;
    display.badges.push({ text: 'Main Idea', type: 'main-idea' });
    display.badges.push({ text: (childCount - incomplete) + '/' + childCount + ' tasks done', type: 'initiative-progress' });
    display.childCount = childCount;
    display.incompleteChildren = incomplete;
  }

  // Pipeline step — server determines which step is active
  display.pipelineComplete = (card.column_name === 'done' || st === 'complete');
  if (display.pipelineComplete) display.pipelineStep = 'done';
  else if (st === 'initiative-active') display.pipelineStep = 'spec';
  else if (st === 'fixing') display.pipelineStep = 'fix';
  else if (st === 'reviewing') display.pipelineStep = 'review';
  else if (st === 'building') display.pipelineStep = 'build';
  else if (st === 'queued') display.pipelineStep = 'queue';
  else if (st === 'brainstorming') display.pipelineStep = 'spec';
  else if (card.column_name === 'review') display.pipelineStep = 'review';
  else if (card.column_name === 'working') display.pipelineStep = 'build';
  else if (card.spec) display.pipelineStep = 'spec';
  else if (card.project_path) display.pipelineStep = 'folder';
  else display.pipelineStep = null;

  return display;
}

// Server-driven UI: enrichCard includes actions ONLY when user is authenticated.
// Anonymous viewers see cards + display state, but no action buttons.
// This is the core of "UI is dumb, server is king" — server decides what controls to show.
// isAuthed: true = include actions, false = strip actions, undefined = include (for broadcasts to authed clients)
// SSE broadcasts always include actions — frontend strips them for public viewers based on userRole.
function enrichCard(card, allCards, isAuthed) {
  if (!card) return card;
  card.actions = (isAuthed === false) ? [] : computeActions(card);
  card.display = computeDisplay(card, allCards);
  return card;
}

function enrichCards(list, isAuthed) {
  for (let i = 0; i < list.length; i++) enrichCard(list[i], list, isAuthed);
  return list;
}

// =============================================================================
// READ ENDPOINTS — open to public (optionalAuth).
// Server includes actions only for authenticated users.
// =============================================================================

router.get('/api/cards', optionalAuth, function(req, res) {
  const authed = !!req.user;
  res.json(enrichCards(cards.getAll(), authed));
});

router.get('/api/queue', optionalAuth, function(_req, res) { res.json(pipeline.getQueueInfo()); });
router.get('/api/activities', optionalAuth, function(_req, res) { res.json(pipeline.getActivities()); });
router.get('/api/pipeline', optionalAuth, function(_req, res) { res.json({ paused: pipeline.isPaused() }); });
router.get('/api/search', optionalAuth, function(req, res) {
  if (!req.query.q) return res.json([]);
  res.json(enrichCards(cards.search(req.query.q), !!req.user));
});
router.get('/api/metrics', optionalAuth, function(_req, res) { res.json(support.getMetrics()); });
router.get('/api/spec-intelligence', optionalAuth, function(_req, res) { res.json(require('../services/spec-intelligence').getInsights()); });
router.get('/api/export', requireAuth, function(_req, res) { res.json(support.exportBoard()); });

router.get('/api/archive', optionalAuth, function(req, res) {
  const archived = cards.getArchived();
  const limit = runtime.maxArchiveVisible;
  res.json(enrichCards(limit > 0 ? archived.slice(0, limit) : archived, !!req.user));
});

router.get('/api/cards/:id/review', optionalAuth, function(req, res) {
  const card = cards.get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (!card.review_data) return res.json({ score: 0, findings: [] });
  try { res.json(JSON.parse(card.review_data)); }
  catch (_) { res.json({ score: card.review_score || 0, findings: [] }); }
});

router.get('/api/cards/:id/sessions', optionalAuth, function(req, res) {
  res.json(sessions.getByCard(Number(req.params.id)));
});

router.get('/api/cards/:id/has-snapshot', optionalAuth, function(req, res) {
  res.json({ has: snapshot.has(Number(req.params.id)) });
});

router.get('/api/cards/:id/diff', optionalAuth, function(req, res) {
  const result = support.getDiff(Number(req.params.id));
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.get('/api/cards/:id/log/:type', optionalAuth, function(req, res) {
  if (!isAllowedLogType(req.params.type)) return res.status(400).json({ error: 'Invalid log type' });
  const logFile = path.join(LOGS_DIR, 'card-' + req.params.id + '-' + req.params.type + '.log');
  const resolved = path.resolve(logFile);
  if (!resolved.startsWith(path.resolve(LOGS_DIR) + path.sep)) return res.status(403).json({ error: 'Path traversal blocked' });
  if (!fs.existsSync(logFile)) return res.status(404).json({ error: 'No log found' });
  res.type('text/plain').send(fs.readFileSync(logFile, 'utf-8'));
});

router.get('/api/cards/:id/log-stream', optionalAuth, function(req, res) {
  const id = req.params.id;
  const type = req.query.type || 'build';
  if (!isAllowedLogType(type)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Invalid log type');
  }
  const logFile = path.join(LOGS_DIR, 'card-' + id + '-' + type + '.log');
  const resolvedLog = path.resolve(logFile);
  if (!resolvedLog.startsWith(path.resolve(LOGS_DIR) + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Path traversal blocked');
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n');

  let lastSize = 0;
  let fileFound = false;

  if (fs.existsSync(logFile)) {
    fileFound = true;
    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      res.write('data: ' + JSON.stringify({ type: 'initial', content: content }) + '\n\n');
      lastSize = fs.statSync(logFile).size;
    } catch (_) {}
  } else {
    res.write('data: ' + JSON.stringify({ type: 'waiting', content: 'Waiting for log file...' }) + '\n\n');
  }

  const heartbeat = setInterval(function() {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 15000);

  const interval = setInterval(function() {
    try {
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (!fileFound) {
        fileFound = true;
        const c = fs.readFileSync(logFile, 'utf-8');
        res.write('data: ' + JSON.stringify({ type: 'initial', content: c }) + '\n\n');
        lastSize = stat.size;
        return;
      }
      if (stat.size > lastSize) {
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(stat.size - lastSize);
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        res.write('data: ' + JSON.stringify({ type: 'append', content: buf.toString('utf-8') }) + '\n\n');
      }
    } catch (_) {}
  }, 1000);

  req.on('close', function() { clearInterval(interval); clearInterval(heartbeat); });
});

// Config — public gets limited view (no server internals)
router.get('/api/config', optionalAuth, function(_req, res) { res.json(usageSvc.getConfig(pipeline.getPipelineState())); });

// Mode info — public can see mode state (needed for UI toggles like hiding "new card" button)
router.get('/api/mode', optionalAuth, function(_req, res) { res.json(autoDiscover.getState()); });

// =============================================================================
// WRITE ENDPOINTS — ALL require authentication
// =============================================================================

// --- Auto-Archive (internal helper) ---
function autoArchiveDone() {
  const doneCards = cards.getAll().filter(function(c) { return c.column_name === 'done'; });
  if (doneCards.length <= 5) return;
  doneCards.sort(function(a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
  const toArchive = doneCards.slice(5);
  for (let i = 0; i < toArchive.length; i++) {
    cards.move(toArchive[i].id, 'archive');
    auditLog('auto-archive', 'card', toArchive[i].id, 'system', 'done', 'archive', toArchive[i].title);
    broadcast('card-deleted', { id: toArchive[i].id });
  }
  if (toArchive.length > 0) {
    broadcast('toast', { message: toArchive.length + ' card(s) auto-archived', type: 'info' });
  }
  const rotated = cards.rotateArchive();
  for (let j = 0; j < rotated.length; j++) {
    snapshot.clear(rotated[j]);
  }
}

// --- Cards CRUD ---
router.post('/api/cards', requireAuth, function(req, res) {
  const title = req.body.title;
  const description = req.body.description;
  const column = req.body.column;
  if (!title) return res.status(400).json({ error: 'Title required' });
  // M7: Input length limits
  if (title.length > 500) return res.status(400).json({ error: 'Title too long (max 500 chars)' });
  if (description && description.length > 10000) return res.status(400).json({ error: 'Description too long (max 10K chars)' });
  const limitErr = checkCardLimit();
  if (limitErr) return res.status(429).json({ error: limitErr });
  const result = cards.create(title, description, column);
  const card = cards.get(Number(result.lastInsertRowid));
  // Intelligence: auto-label based on learned patterns
  if (!card.labels) {
    const autoLabels = intelligence.autoLabel(title, description);
    if (autoLabels) {
      intelligence.checkpoint('Auto-label card #' + card.id, 'auto-label',
        autoLabels, { cardId: card.id, oldLabels: '' });
      cards.setLabels(card.id, autoLabels);
    }
  }
  auditLog('create', 'card', card.id, req.user.id, '', card.title, '');
  broadcast('card-created', enrichCard(cards.get(card.id)));
  res.json(enrichCard(cards.get(card.id)));
});

router.put('/api/cards/:id', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  if (req.body.title && req.body.title.length > 500) return res.status(400).json({ error: 'Title too long (max 500 chars)' });
  if (req.body.description && req.body.description.length > 10000) return res.status(400).json({ error: 'Description too long (max 10K chars)' });
  const old = cards.get(id);
  cards.update(id, req.body.title, req.body.description);
  const card = cards.get(id);
  auditLog('update', 'card', id, req.user.id, old ? old.title : '', req.body.title, 'edited');
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

router.delete('/api/cards/:id', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  auditLog('delete', 'card', id, req.user.id, '', '', 'deleted');
  cards.delete(id);
  broadcast('card-deleted', { id: id });
  res.json({ success: true });
});

// --- Move Card ---
router.post('/api/cards/:id/move', requireAuth, function(req, res) {
  const column = req.body.column;
  const source = req.body.source;
  if (!VALID_COLUMNS.includes(column)) return res.status(400).json({ error: 'Invalid column: ' + column });
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const fromColumn = card.column_name;
  if (fromColumn === column) return res.json(enrichCard(card));
  auditLog('move', 'card', id, source || req.user.id, fromColumn, column, card.title);

  let dequeueResult = { removed: false };
  if (fromColumn === 'working' || (fromColumn === 'todo' && card.status === 'queued')) {
    dequeueResult = pipeline.dequeue(id);
    if (fromColumn === 'todo' && dequeueResult.removed) {
      cards.setStatus(id, 'idle');
    }
  }

  cards.move(id, column);

  if (column === 'working' && card.spec) {
    try {
      pipeline.enqueue(id, source === 'human' ? 1 : 0);
      return res.json(enrichCard(cards.get(id)));
    } catch (err) {
      log.error({ cardId: id, err: err.message }, 'Enqueue failed');
      pipeline.dequeue(id);
      cards.setStatus(id, 'idle');
      broadcast('card-updated', enrichCard(cards.get(id)));
      broadcast('toast', { message: err.message, type: 'error' });
      return res.status(409).json({ error: err.message, card: enrichCard(cards.get(id)) });
    }
  }

  if (column === 'done') {
    cards.setStatus(id, 'complete');
    git.autoChangelog(id);
    git.autoCommit(id);
    autoArchiveDone();
    pipeline.releaseProjectLock(id);
    pipeline.checkUnblock();
    require('../services/review').checkParentInitiativeComplete(id);
  } else if (dequeueResult.wasBuilding) {
    cards.setStatus(id, 'interrupted');
  } else {
    cards.setStatus(id, 'idle');
  }

  broadcast('card-updated', enrichCard(cards.get(id)));
  res.json(enrichCard(cards.get(id)));
});

// --- Card Actions ---
router.post('/api/cards/:id/detect', requireAuth, function(req, res) {
  const card = cards.get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(support.detectProject(card.title));
});

router.post('/api/cards/:id/assign-folder', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  if (!req.body.projectPath) return res.status(400).json({ error: 'projectPath required' });
  const pathErr = support.validateProjectPath(req.body.projectPath);
  if (pathErr) return res.status(400).json({ error: pathErr });
  cards.setProjectPath(id, path.resolve(req.body.projectPath));
  const card = cards.get(id);
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

router.post('/api/cards/:id/brainstorm', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  // Server decides if project path is needed — frontend never checks
  if (!card.project_path) {
    return res.status(400).json({
      error: 'Project path required before brainstorming',
      code: 'NEEDS_PROJECT',
      detection: support.detectProject(card.title),
    });
  }
  // Single-project mode: pre-check — one brainstorm at a time
  const check = brainstormSvc.canBrainstorm(id);
  if (!check.allowed) {
    return res.status(409).json({ error: check.reason, code: 'BRAINSTORM_BLOCKED' });
  }
  res.json({ success: true, message: 'Brainstorming started' });
  brainstormSvc.brainstorm(id).catch(function(err) {
    broadcast('error', { cardId: id, message: err.message });
  });
});

router.post('/api/cards/:id/start-work', requireAuth, function(req, res) {
  try {
    res.json(pipeline.startWork(Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message, code: 'START_WORK_FAILED' });
  }
});

// --- Security: Spawn endpoints (vscode/terminal/claude) only from localhost ---
// These spawn desktop processes on the server machine — must never execute from remote requests.
const LOCALHOST_RE = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
function requireLocalhost(req, res, next) {
  const ip = req.socket ? (req.socket.remoteAddress || '') : '';
  if (!LOCALHOST_RE.test(ip)) {
    return res.status(403).json({ error: 'Spawn endpoints are localhost-only' });
  }
  next();
}

router.post('/api/cards/:id/open-vscode', requireAuth, requireLocalhost, function(req, res) {
  try { support.openInVSCode(Number(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/cards/:id/open-terminal', requireAuth, requireLocalhost, function(req, res) {
  try { support.openTerminal(Number(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/cards/:id/open-claude', requireAuth, requireLocalhost, function(req, res) {
  try { support.openClaude(Number(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Approve ---
router.post('/api/cards/:id/approve', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (card && (!card.review_score || card.review_score === 0) && card.project_path) {
    try {
      const rcPath = path.join(card.project_path, '.review-complete');
      if (fs.existsSync(rcPath)) {
        const rc = JSON.parse(fs.readFileSync(rcPath, 'utf-8'));
        if (rc.score) cards.setReviewData(id, rc.score, JSON.stringify(rc));
      }
    } catch (_) {}
  }
  cards.move(id, 'done');
  cards.setStatus(id, 'complete');
  cards.setApprovedBy(id, 'human');
  // Intelligence: learn from completed build
  intelligence.learnFromBuild(id);
  // Spec intelligence: score spec effectiveness (human-approved)
  try { require('../services/spec-intelligence').computeSpecEffectiveness(id, card.review_score || 7, 0, false); } catch (_) {}
  auditLog('approve', 'card', id, req.user.id, card ? card.status : '', 'complete', card ? card.title : '');
  broadcast('card-updated', enrichCard(cards.get(id)));
  const clResult = git.autoChangelog(id);
  if (clResult.success) broadcast('toast', { message: 'Changelog: ' + clResult.type + ' entry added', type: 'success' });
  const gitResult = git.autoCommit(id);
  if (gitResult.success && gitResult.action !== 'no-changes') broadcast('toast', { message: 'Git: ' + gitResult.action, type: 'success' });
  autoArchiveDone();
  pipeline.releaseProjectLock(id);
  pipeline.checkUnblock();
  // If this card is a sub-task, check if the parent initiative is now complete
  require('../services/review').checkParentInitiativeComplete(id);
  res.json({ card: enrichCard(cards.get(id)), git: gitResult, changelog: clResult });
});

// --- Reject ---
router.post('/api/cards/:id/reject', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  const card = cards.get(id);
  const result = snapshot.rollback(id);
  cards.move(id, 'todo');
  cards.setStatus(id, 'idle');
  cards.setSessionLog(id, 'REJECTED - Files rolled back. ' + (result.success ? (result.wasNew ? 'New project folder removed.' : 'All files restored to pre-work state.') : result.reason));
  auditLog('reject', 'card', id, req.user.id, card ? card.column_name : '', 'todo', card ? card.title : '');
  broadcast('card-updated', enrichCard(cards.get(id)));
  pipeline.releaseProjectLock(id);
  const cascaded = pipeline.cascadeRevert(id);
  res.json({ card: enrichCard(cards.get(id)), rollback: result, cascaded: cascaded });
});

// --- Edit File ---
router.post('/api/cards/:id/edit-file', requireAuth, express.json({ limit: '5mb' }), function(req, res) {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card || !card.project_path) return res.status(404).json({ error: 'Card or project not found' });
  const filePath = req.body.filePath;
  const content = req.body.content;
  if (!filePath || content === undefined) return res.status(400).json({ error: 'filePath and content required' });
  // C5 fix: validate project_path itself is under PROJECTS_ROOT
  if (!isPathUnderProjectsRoot(card.project_path)) {
    return res.status(403).json({ error: 'Project path not under allowed root' });
  }
  const resolvedProject = path.resolve(card.project_path);
  const fullPath = path.resolve(resolvedProject, filePath);
  if (!fullPath.startsWith(resolvedProject + path.sep) && fullPath !== resolvedProject) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }
  try {
    fs.writeFileSync(fullPath, content, 'utf-8');
    broadcast('toast', { message: 'Saved: ' + filePath, type: 'success' });
    res.json({ success: true, file: filePath });
  } catch (err) {
    res.status(500).json({ error: 'Write failed: ' + err.message });
  }
});

// --- Revert / Snapshot ---
router.post('/api/cards/:id/revert-files', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (!snapshot.has(id)) return res.status(404).json({ error: 'No snapshot available for this card' });
  const result = snapshot.revert(id);
  if (result.success) {
    broadcast('toast', { message: 'Files reverted to pre-work state for: ' + card.title, type: 'success' });
    pipeline.cascadeRevert(id);
  }
  res.json(result);
});

// --- Spec / Labels / Deps ---
router.put('/api/cards/:id/spec', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  const old = cards.get(id);
  const spec = req.body.spec;
  if (typeof spec !== 'string') return res.status(400).json({ error: 'spec required' });
  if (spec.length > 100000) return res.status(400).json({ error: 'Spec too long (max 100K chars)' });
  cards.setSpec(id, spec);
  auditLog('edit-spec', 'card', id, req.user.id, (old && old.spec) ? old.spec.slice(0, 200) : '', spec.slice(0, 200), '');
  const card = cards.get(id);
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

router.put('/api/cards/:id/labels', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  const old = cards.get(id);
  if (typeof req.body.labels !== 'string') return res.status(400).json({ error: 'labels required' });
  if (req.body.labels.length > 1000) return res.status(400).json({ error: 'Labels too long (max 1000 chars)' });
  cards.setLabels(id, req.body.labels);
  // Intelligence: learn from user's label choices
  intelligence.learnFromLabels(id);
  auditLog('edit-labels', 'card', id, req.user.id, old ? old.labels : '', req.body.labels, '');
  const card = cards.get(id);
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

router.put('/api/cards/:id/depends-on', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  const old = cards.get(id);
  if (typeof req.body.dependsOn !== 'string') return res.status(400).json({ error: 'dependsOn required' });
  if (req.body.dependsOn.length > 500) return res.status(400).json({ error: 'Dependencies too long (max 500 chars)' });
  // Validate format: only comma-separated numbers
  if (req.body.dependsOn && !/^[\d,\s]+$/.test(req.body.dependsOn)) {
    return res.status(400).json({ error: 'Dependencies must be comma-separated card IDs' });
  }
  cards.setDependsOn(id, req.body.dependsOn);
  auditLog('edit-deps', 'card', id, req.user.id, old ? old.depends_on : '', req.body.dependsOn, '');
  const card = cards.get(id);
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

// --- Retry / Preview ---
router.post('/api/cards/:id/retry', requireAuth, function(req, res) {
  if (!req.body.feedback) return res.status(400).json({ error: 'feedback required' });
  if (req.body.feedback.length > 10000) return res.status(400).json({ error: 'Feedback too long (max 10K chars)' });
  // Intelligence: learn from feedback themes
  intelligence.learnFromFeedback(req.body.feedback);
  try {
    res.json(pipeline.retryWithFeedback(Number(req.params.id), req.body.feedback));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/cards/:id/preview', requireAuth, requireLocalhost, function(req, res) {
  try { res.json(support.previewProject(Number(req.params.id))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Promote brainstorm to todo (manual approval in single-project mode) ---
router.post('/api/cards/:id/promote', requireAuth, function(req, res) {
  brainstormSvc.promoteToTodo(Number(req.params.id)).then(function(result) {
    res.json({ success: true, result: result });
  }).catch(function(err) {
    res.status(400).json({ error: err.message });
  });
});

// --- Pipeline Control ---
router.post('/api/pipeline/pause', requireAuth, function(_req, res) { pipeline.setPaused(true); res.json({ paused: true }); });
router.post('/api/pipeline/resume', requireAuth, function(_req, res) { pipeline.setPaused(false); res.json({ paused: false }); });
router.post('/api/cards/:id/stop', requireAuth, function(req, res) {
  try { res.json(pipeline.stopCard(Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Bulk Create ---
router.post('/api/bulk-create', requireAuth, function(req, res) {
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
  const limitErr = checkCardLimit();
  if (limitErr) return res.status(429).json({ error: limitErr });
  const created = [];
  const batch = items.slice(0, 50);
  for (let i = 0; i < batch.length; i++) {
    if (!batch[i].title) continue;
    // Enforce per-item length limits
    const itemTitle = String(batch[i].title).slice(0, 500);
    const itemDesc = batch[i].description ? String(batch[i].description).slice(0, 10000) : '';
    const result = cards.create(itemTitle, itemDesc, batch[i].column || 'brainstorm');
    const card = cards.get(Number(result.lastInsertRowid));
    if (batch[i].labels) cards.setLabels(card.id, batch[i].labels);
    broadcast('card-created', enrichCard(cards.get(card.id)));
    created.push(enrichCard(cards.get(card.id)));
  }
  res.json({ created: created.length, cards: created });
});

// --- Folders — list project directories for folder picker ---
router.get('/api/folders', requireAuth, function(_req, res) {
  try {
    const entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
    const allDirs = entries.filter(function(e) { return e.isDirectory(); });
    let hidden = 0;
    const folders = allDirs
      .filter(function(e) {
        var n = e.name;
        // Hidden / dollar-prefixed (all OSes)
        if (n.startsWith('.') || n.startsWith('$') || n.startsWith('~')) { hidden++; return false; }
        // Windows system dirs
        if (/^(System Volume Information|Recovery|PerfLogs|MSOCache|Config\.Msi|Documents and Settings|Boot|Windows|Program Files( \(x86\))?|ProgramData|Intel|AMD)$/i.test(n)) { hidden++; return false; }
        // macOS system dirs
        if (/^(Library|System|Volumes|cores|private)$/.test(n)) { hidden++; return false; }
        // Linux system/root dirs
        if (/^(proc|sys|dev|run|boot|lost\+found|snap|mnt|media|tmp|var|etc|usr|bin|sbin|lib|lib32|lib64|libx32|opt|root|srv)$/.test(n)) { hidden++; return false; }
        return true;
      })
      .map(function(e) { return e.name; })
      .sort();
    res.json({ root: PROJECTS_ROOT, folders: folders, hidden: hidden });
  } catch (e) {
    res.json({ root: PROJECTS_ROOT, folders: [], hidden: 0 });
  }
});

// --- Ideas — natural language input that auto-creates and processes cards ---
router.post('/api/ideas', requireAuth, function(req, res) {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Idea text required' });
  if (text.length > 5000) return res.status(400).json({ error: 'Idea too long (max 5000 chars)' });
  const limitErr = checkCardLimit();
  if (limitErr) return res.status(429).json({ error: limitErr });

  // Extract title from first line (max 80 chars), full text as description
  const lines = text.split('\n');
  const title = lines[0].substring(0, 80);
  const description = text;

  // Create card
  const result = cards.create(title, description, 'brainstorm');
  const cardId = Number(result.lastInsertRowid);

  // Intelligence: auto-label idea cards
  const ideaLabels = intelligence.autoLabel(title, description);
  if (ideaLabels) {
    intelligence.checkpoint('Auto-label idea #' + cardId, 'auto-label', ideaLabels, { cardId: cardId, oldLabels: '' });
    cards.setLabels(cardId, ideaLabels);
  }

  // Assign project folder — validate if user-supplied
  let projectPath = (req.body.projectPath || '').trim();
  if (projectPath) {
    const pathErr = support.validateProjectPath(projectPath);
    if (pathErr) {
      cards.delete(cardId); // rollback the created card
      return res.status(400).json({ error: pathErr });
    }
    projectPath = path.resolve(projectPath);
  }
  if (!projectPath) {
    // Create new project folder — never reuse existing
    const slug = title.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50) || 'new-project';
    let folderName = slug;
    let counter = 1;
    while (fs.existsSync(path.join(PROJECTS_ROOT, folderName))) {
      folderName = slug + '-' + counter;
      counter++;
    }
    projectPath = path.join(PROJECTS_ROOT, folderName);
    fs.mkdirSync(projectPath, { recursive: true });
  }
  cards.setProjectPath(cardId, projectPath);

  auditLog('idea-create', 'card', cardId, req.user.id, '', title, 'idea-bar');
  broadcast('card-created', enrichCard(cards.get(cardId)));

  // Auto-trigger brainstorm
  try {
    brainstormSvc.brainstorm(cardId);
  } catch (e) {
    // Non-blocking — card exists, user can brainstorm manually
    log.warn({ cardId, err: e.message }, 'Auto-brainstorm after idea failed');
  }

  res.json(enrichCard(cards.get(cardId)));
});

// --- Feedback — append user feedback to card spec, dequeue if queued ---
router.post('/api/cards/:id/feedback', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  const text = (req.body.text || '').trim();
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (!text) return res.status(400).json({ error: 'Feedback text required' });
  if (text.length > 5000) return res.status(400).json({ error: 'Feedback too long (max 5000 chars)' });

  // Append feedback to spec (or description if no spec yet)
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const feedbackBlock = '\n\n## User Feedback (' + timestamp + ')\n' + text;
  if (card.spec) {
    cards.setSpec(id, card.spec + feedbackBlock);
  } else {
    cards.update(id, card.title, (card.description || '') + feedbackBlock);
  }

  // If card was queued, dequeue it — user is refining, don't auto-build
  if (card.status === 'queued') {
    try { pipeline.dequeue(id); } catch (_) {}
    cards.setStatus(id, 'idle');
  }

  auditLog('feedback', 'card', id, req.user.id, '', text.substring(0, 100), '');
  broadcast('card-updated', enrichCard(cards.get(id)));
  broadcast('toast', { message: 'Feedback added to #' + id, type: 'success' });
  res.json(enrichCard(cards.get(id)));
});

// --- Intelligence: Rollback (available from main board — mandatory access) ---
router.get('/api/checkpoints', requireAuth, function(req, res) {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  res.json(intelligence.getCheckpoints(limit));
});

router.post('/api/checkpoints/:id/rollback', requireAuth, function(req, res) {
  const result = intelligence.rollback(Number(req.params.id));
  if (result.success) {
    auditLog('rollback', 'checkpoint', Number(req.params.id), req.user.id, '', result.label, result.reverted.join('; '));
  }
  res.json(result);
});

// --- Unarchive ---
router.post('/api/cards/:id/unarchive', requireAuth, function(req, res) {
  const id = Number(req.params.id);
  if (!cards.get(id)) return res.status(404).json({ error: 'Card not found' });
  cards.move(id, 'done');
  broadcast('card-created', enrichCard(cards.get(id)));
  autoArchiveDone();
  res.json(enrichCard(cards.get(id)));
});

// --- Test-only (L1 fix: require auth even in test mode) ---
if (process.env.NODE_ENV === 'test') {
  router.put('/api/test/cards/:id/state', requireAuth, function(req, res) {
    const id = Number(req.params.id);
    if (!cards.get(id)) return res.status(404).json({ error: 'Not found' });
    cards.updateState(id, req.body);
    broadcast('card-updated', enrichCard(cards.get(id)));
    res.json(enrichCard(cards.get(id)));
  });
}

// Export enrichCard for broadcast enrichment
router.enrichCard = enrichCard;

module.exports = router;
