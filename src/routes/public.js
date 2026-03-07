var express = require('express');
var fs = require('fs');
var path = require('path');
var { cards, sessions, auditLog, VALID_COLUMNS } = require('../db');
var { broadcast, sseClients } = require('../lib/broadcast');
var { LOGS_DIR, ADMIN_PIN, runtime } = require('../config');
var { requireAuth } = require('../lib/session');
var { PinAuthProvider, createSessionHandler, createLoginHandler, logoutHandler } = require('../middleware/auth');
var pipeline = require('../services/pipeline');
var brainstormSvc = require('../services/brainstorm');
var support = require('../services/support');
var git = require('../services/git');
var snapshot = require('../services/snapshot');
var usageSvc = require('../services/usage');

var router = express.Router();

// --- Auth Provider (shared with admin) ---
var authProvider = new PinAuthProvider(ADMIN_PIN);

// --- Auth Routes (session-based, HTTP-only cookies) ---
// Frontend calls these — never sees tokens. Browser handles cookie automatically.
router.get('/api/auth/session', createSessionHandler(authProvider));
router.post('/api/auth/login', createLoginHandler(authProvider));
router.post('/api/auth/logout', logoutHandler);

// --- SSE (read-only, no auth required) ---
router.get('/api/events', function(req, res) {
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
  var actions = [];
  var col = card.column_name;
  var st = card.status;

  // Always available (except archive)
  if (col !== 'archive') {
    actions.push('edit');
    actions.push('delete');
    actions.push('edit-labels');
    actions.push('edit-deps');
  }

  if (st === 'interrupted') {
    actions.push('retry');
    actions.push('re-brainstorm');
    actions.push('reject');
    actions.push('discard');
    if (card.project_path) actions.push('open-vscode');
    return actions;
  }

  switch (col) {
    case 'brainstorm':
      actions.push('detect-project');
      if (card.project_path && !card.spec) actions.push('brainstorm');
      if (card.project_path && card.spec) actions.push('brainstorm'); // re-brainstorm
      if (card.spec) actions.push('move-to-todo');
      break;

    case 'todo':
      if (st === 'blocked') {
        actions.push('retry');
        if (card.project_path) actions.push('open-vscode');
        actions.push('discard');
      } else if (st === 'queued') {
        actions.push('cancel-queue');
        if (card.project_path) actions.push('open-vscode');
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
      if (card.project_path) {
        actions.push('open-vscode');
        actions.push('open-terminal');
        actions.push('open-claude');
      }
      actions.push('view-log');
      break;

    case 'review':
      actions.push('approve');
      actions.push('reject');
      actions.push('retry-with-feedback');
      actions.push('diff');
      if (card.project_path) actions.push('open-vscode');
      if (card.review_score > 0) actions.push('view-findings');
      if (st === 'reviewing') actions.push('view-log');
      if (st === 'fixing') actions.push('view-fix-log');
      break;

    case 'done':
      if (card.project_path) {
        actions.push('open-vscode');
        actions.push('preview');
        actions.push('diff');
        actions.push('revert');
      }
      break;

    case 'archive':
      actions.push('unarchive');
      break;
  }

  // Spec editing
  if (card.spec && col !== 'archive') actions.push('edit-spec');

  return actions;
}

// Server-computed display state — frontend renders this, makes zero decisions
function computeDisplay(card, allCards) {
  var display = { badges: [], pipelineStep: null };
  var st = card.status;

  // Status badges — server decides what badge to show
  if (st === 'frozen') display.badges.push({ text: 'Frozen', type: 'blocked' });
  else if (st === 'fix-interrupted') display.badges.push({ text: 'Fix Paused', type: 'warning' });
  else if (st === 'brainstorming') display.badges.push({ text: 'Brainstorming', type: 'brainstorming', spinner: true });
  else if (st === 'queued') {
    var qInfo = pipeline.getQueueInfo();
    var qPos = -1;
    if (qInfo && qInfo.queue) {
      for (var qi = 0; qi < qInfo.queue.length; qi++) {
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
    var deps = card.depends_on.split(',').filter(Boolean);
    var blockedBy = [];
    for (var d = 0; d < deps.length; d++) {
      var depId = Number(deps[d].trim());
      for (var c = 0; c < allCards.length; c++) {
        if (allCards[c].id === depId && allCards[c].column_name !== 'done' && allCards[c].column_name !== 'archive') {
          blockedBy.push('#' + depId);
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

  // Pipeline step — server determines which step is active
  display.pipelineComplete = (card.column_name === 'done' || st === 'complete');
  if (display.pipelineComplete) display.pipelineStep = 'done';
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

function enrichCard(card, allCards) {
  if (!card) return card;
  card.actions = computeActions(card);
  card.display = computeDisplay(card, allCards);
  return card;
}

function enrichCards(list) {
  for (var i = 0; i < list.length; i++) enrichCard(list[i], list);
  return list;
}

// =============================================================================
// READ-ONLY ENDPOINTS (no auth — safe to view)
// =============================================================================

router.get('/api/cards', function(_req, res) {
  res.json(enrichCards(cards.getAll()));
});

router.get('/api/queue', function(_req, res) { res.json(pipeline.getQueueInfo()); });
router.get('/api/activities', function(_req, res) { res.json(pipeline.getActivities()); });
router.get('/api/pipeline', function(_req, res) { res.json({ paused: pipeline.isPaused() }); });
router.get('/api/search', function(req, res) {
  if (!req.query.q) return res.json([]);
  res.json(enrichCards(cards.search(req.query.q)));
});
router.get('/api/metrics', function(_req, res) { res.json(support.getMetrics()); });
router.get('/api/export', function(_req, res) { res.json(support.exportBoard()); });

router.get('/api/archive', function(_req, res) {
  var archived = cards.getArchived();
  var limit = runtime.maxArchiveVisible;
  res.json(enrichCards(limit > 0 ? archived.slice(0, limit) : archived));
});

router.get('/api/cards/:id/review', function(req, res) {
  var card = cards.get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (!card.review_data) return res.json({ score: 0, findings: [] });
  try { res.json(JSON.parse(card.review_data)); }
  catch (_) { res.json({ score: card.review_score || 0, findings: [] }); }
});

router.get('/api/cards/:id/sessions', function(req, res) {
  res.json(sessions.getByCard(Number(req.params.id)));
});

router.get('/api/cards/:id/has-snapshot', function(req, res) {
  res.json({ has: snapshot.has(Number(req.params.id)) });
});

router.get('/api/cards/:id/diff', function(req, res) {
  var result = support.getDiff(Number(req.params.id));
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.get('/api/cards/:id/log/:type', function(req, res) {
  var logFile = path.join(LOGS_DIR, 'card-' + req.params.id + '-' + req.params.type + '.log');
  if (!fs.existsSync(logFile)) return res.status(404).json({ error: 'No log found' });
  res.type('text/plain').send(fs.readFileSync(logFile, 'utf-8'));
});

router.get('/api/cards/:id/log-stream', function(req, res) {
  var id = req.params.id;
  var type = req.query.type || 'build';
  var logFile = path.join(LOGS_DIR, 'card-' + id + '-' + type + '.log');

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n');

  var lastSize = 0;
  var fileFound = false;

  if (fs.existsSync(logFile)) {
    fileFound = true;
    try {
      var content = fs.readFileSync(logFile, 'utf-8');
      res.write('data: ' + JSON.stringify({ type: 'initial', content: content }) + '\n\n');
      lastSize = fs.statSync(logFile).size;
    } catch (_) {}
  } else {
    res.write('data: ' + JSON.stringify({ type: 'waiting', content: 'Waiting for log file...' }) + '\n\n');
  }

  var heartbeat = setInterval(function() {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 15000);

  var interval = setInterval(function() {
    try {
      if (!fs.existsSync(logFile)) return;
      var stat = fs.statSync(logFile);
      if (!fileFound) {
        fileFound = true;
        var c = fs.readFileSync(logFile, 'utf-8');
        res.write('data: ' + JSON.stringify({ type: 'initial', content: c }) + '\n\n');
        lastSize = stat.size;
        return;
      }
      if (stat.size > lastSize) {
        var fd = fs.openSync(logFile, 'r');
        var buf = Buffer.alloc(stat.size - lastSize);
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        res.write('data: ' + JSON.stringify({ type: 'append', content: buf.toString('utf-8') }) + '\n\n');
      }
    } catch (_) {}
  }, 1000);

  req.on('close', function() { clearInterval(interval); clearInterval(heartbeat); });
});

// Config is read-only on public (no sensitive data exposed)
router.get('/api/config', function(_req, res) { res.json(usageSvc.getConfig(pipeline.getPipelineState())); });

// =============================================================================
// WRITE ENDPOINTS — ALL require authentication
// =============================================================================

// --- Auto-Archive (internal helper) ---
function autoArchiveDone() {
  var doneCards = cards.getAll().filter(function(c) { return c.column_name === 'done'; });
  if (doneCards.length <= 5) return;
  doneCards.sort(function(a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
  var toArchive = doneCards.slice(5);
  for (var i = 0; i < toArchive.length; i++) {
    cards.move(toArchive[i].id, 'archive');
    auditLog('auto-archive', 'card', toArchive[i].id, 'system', 'done', 'archive', toArchive[i].title);
    broadcast('card-deleted', { id: toArchive[i].id });
  }
  if (toArchive.length > 0) {
    broadcast('toast', { message: toArchive.length + ' card(s) auto-archived', type: 'info' });
  }
  var rotated = cards.rotateArchive();
  for (var j = 0; j < rotated.length; j++) {
    snapshot.clear(rotated[j]);
  }
}

// --- Cards CRUD ---
router.post('/api/cards', requireAuth, function(req, res) {
  var title = req.body.title;
  var description = req.body.description;
  var column = req.body.column;
  if (!title) return res.status(400).json({ error: 'Title required' });
  var result = cards.create(title, description, column);
  var card = cards.get(Number(result.lastInsertRowid));
  auditLog('create', 'card', card.id, req.user.id, '', card.title, '');
  broadcast('card-created', enrichCard(cards.get(card.id)));
  res.json(enrichCard(card));
});

router.put('/api/cards/:id', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  var old = cards.get(id);
  cards.update(id, req.body.title, req.body.description);
  var card = cards.get(id);
  auditLog('update', 'card', id, req.user.id, old ? old.title : '', req.body.title, 'edited');
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

router.delete('/api/cards/:id', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  auditLog('delete', 'card', id, req.user.id, '', '', 'deleted');
  cards.delete(id);
  broadcast('card-deleted', { id: id });
  res.json({ success: true });
});

// --- Move Card ---
router.post('/api/cards/:id/move', requireAuth, function(req, res) {
  var column = req.body.column;
  var source = req.body.source;
  if (!VALID_COLUMNS.includes(column)) return res.status(400).json({ error: 'Invalid column: ' + column });
  var id = Number(req.params.id);
  var card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  var fromColumn = card.column_name;
  if (fromColumn === column) return res.json(enrichCard(card));
  auditLog('move', 'card', id, source || req.user.id, fromColumn, column, card.title);

  var dequeueResult = { removed: false };
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
      console.error('Enqueue failed for card', id, err.message);
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
  var card = cards.get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(support.detectProject(card.title));
});

router.post('/api/cards/:id/assign-folder', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  if (!req.body.projectPath) return res.status(400).json({ error: 'projectPath required' });
  cards.setProjectPath(id, req.body.projectPath);
  var card = cards.get(id);
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

router.post('/api/cards/:id/brainstorm', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  var card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  // Server decides if project path is needed — frontend never checks
  if (!card.project_path) {
    return res.status(400).json({
      error: 'Project path required before brainstorming',
      code: 'NEEDS_PROJECT',
      detection: support.detectProject(card.title),
    });
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
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/cards/:id/open-vscode', requireAuth, function(req, res) {
  try { support.openInVSCode(Number(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/cards/:id/open-terminal', requireAuth, function(req, res) {
  try { support.openTerminal(Number(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/cards/:id/open-claude', requireAuth, function(req, res) {
  try { support.openClaude(Number(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Approve ---
router.post('/api/cards/:id/approve', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  var card = cards.get(id);
  if (card && (!card.review_score || card.review_score === 0) && card.project_path) {
    try {
      var rcPath = path.join(card.project_path, '.review-complete');
      if (fs.existsSync(rcPath)) {
        var rc = JSON.parse(fs.readFileSync(rcPath, 'utf-8'));
        if (rc.score) cards.setReviewData(id, rc.score, JSON.stringify(rc));
      }
    } catch (_) {}
  }
  cards.move(id, 'done');
  cards.setStatus(id, 'complete');
  cards.setApprovedBy(id, 'human');
  auditLog('approve', 'card', id, req.user.id, card ? card.status : '', 'complete', card ? card.title : '');
  broadcast('card-updated', enrichCard(cards.get(id)));
  var clResult = git.autoChangelog(id);
  if (clResult.success) broadcast('toast', { message: 'Changelog: ' + clResult.type + ' entry added', type: 'success' });
  var gitResult = git.autoCommit(id);
  if (gitResult.success && gitResult.action !== 'no-changes') broadcast('toast', { message: 'Git: ' + gitResult.action, type: 'success' });
  autoArchiveDone();
  pipeline.releaseProjectLock(id);
  pipeline.checkUnblock();
  res.json({ card: enrichCard(cards.get(id)), git: gitResult, changelog: clResult });
});

// --- Reject ---
router.post('/api/cards/:id/reject', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  var card = cards.get(id);
  var result = snapshot.rollback(id);
  cards.move(id, 'todo');
  cards.setStatus(id, 'idle');
  cards.setSessionLog(id, 'REJECTED - Files rolled back. ' + (result.success ? (result.wasNew ? 'New project folder removed.' : 'All files restored to pre-work state.') : result.reason));
  auditLog('reject', 'card', id, req.user.id, card ? card.column_name : '', 'todo', card ? card.title : '');
  broadcast('card-updated', enrichCard(cards.get(id)));
  pipeline.releaseProjectLock(id);
  var cascaded = pipeline.cascadeRevert(id);
  res.json({ card: enrichCard(cards.get(id)), rollback: result, cascaded: cascaded });
});

// --- Edit File ---
router.post('/api/cards/:id/edit-file', requireAuth, express.json({ limit: '5mb' }), function(req, res) {
  var id = Number(req.params.id);
  var card = cards.get(id);
  if (!card || !card.project_path) return res.status(404).json({ error: 'Card or project not found' });
  var filePath = req.body.filePath;
  var content = req.body.content;
  if (!filePath || content === undefined) return res.status(400).json({ error: 'filePath and content required' });
  var fullPath = path.resolve(card.project_path, filePath);
  if (!fullPath.startsWith(card.project_path + path.sep) && fullPath !== card.project_path) {
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
  var id = Number(req.params.id);
  var card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (!snapshot.has(id)) return res.status(404).json({ error: 'No snapshot available for this card' });
  var result = snapshot.revert(id);
  if (result.success) {
    broadcast('toast', { message: 'Files reverted to pre-work state for: ' + card.title, type: 'success' });
    pipeline.cascadeRevert(id);
  }
  res.json(result);
});

// --- Spec / Labels / Deps ---
router.put('/api/cards/:id/spec', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  var old = cards.get(id);
  var spec = req.body.spec;
  if (typeof spec !== 'string') return res.status(400).json({ error: 'spec required' });
  cards.setSpec(id, spec);
  auditLog('edit-spec', 'card', id, req.user.id, (old && old.spec) ? old.spec.slice(0, 200) : '', spec.slice(0, 200), '');
  var card = cards.get(id);
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

router.put('/api/cards/:id/labels', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  var old = cards.get(id);
  if (typeof req.body.labels !== 'string') return res.status(400).json({ error: 'labels required' });
  cards.setLabels(id, req.body.labels);
  auditLog('edit-labels', 'card', id, req.user.id, old ? old.labels : '', req.body.labels, '');
  var card = cards.get(id);
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

router.put('/api/cards/:id/depends-on', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  var old = cards.get(id);
  if (typeof req.body.dependsOn !== 'string') return res.status(400).json({ error: 'dependsOn required' });
  cards.setDependsOn(id, req.body.dependsOn);
  auditLog('edit-deps', 'card', id, req.user.id, old ? old.depends_on : '', req.body.dependsOn, '');
  var card = cards.get(id);
  broadcast('card-updated', enrichCard(card));
  res.json(enrichCard(card));
});

// --- Retry / Preview ---
router.post('/api/cards/:id/retry', requireAuth, function(req, res) {
  if (!req.body.feedback) return res.status(400).json({ error: 'feedback required' });
  try {
    res.json(pipeline.retryWithFeedback(Number(req.params.id), req.body.feedback));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/cards/:id/preview', requireAuth, function(req, res) {
  try { res.json(support.previewProject(Number(req.params.id))); }
  catch (err) { res.status(500).json({ error: err.message }); }
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
  var items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
  var created = [];
  var batch = items.slice(0, 50);
  for (var i = 0; i < batch.length; i++) {
    if (!batch[i].title) continue;
    var result = cards.create(batch[i].title, batch[i].description || '', batch[i].column || 'brainstorm');
    var card = cards.get(Number(result.lastInsertRowid));
    if (batch[i].labels) cards.setLabels(card.id, batch[i].labels);
    broadcast('card-created', enrichCard(cards.get(card.id)));
    created.push(enrichCard(cards.get(card.id)));
  }
  res.json({ created: created.length, cards: created });
});

// --- Unarchive ---
router.post('/api/cards/:id/unarchive', requireAuth, function(req, res) {
  var id = Number(req.params.id);
  if (!cards.get(id)) return res.status(404).json({ error: 'Card not found' });
  cards.move(id, 'done');
  broadcast('card-created', enrichCard(cards.get(id)));
  autoArchiveDone();
  res.json(enrichCard(cards.get(id)));
});

// --- Test-only ---
if (process.env.NODE_ENV === 'test') {
  router.put('/api/test/cards/:id/state', function(req, res) {
    var id = Number(req.params.id);
    if (!cards.get(id)) return res.status(404).json({ error: 'Not found' });
    cards.updateState(id, req.body);
    broadcast('card-updated', enrichCard(cards.get(id)));
    res.json(enrichCard(cards.get(id)));
  });
}

// Export enrichCard for broadcast enrichment
router.enrichCard = enrichCard;

module.exports = router;
