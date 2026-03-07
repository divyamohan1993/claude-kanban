const express = require('express');
const fs = require('fs');
const path = require('path');
const { cards, sessions } = require('./db');
const orchestrator = require('./orchestrator');
const snapshot = require('./snapshot');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 51777;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || PORT + 1;
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const DATA_DIR = path.join(__dirname, '.data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// =============================================================================
// PUBLIC APP — listens on 0.0.0.0:PORT, serves board UI + board APIs
// =============================================================================
const app = express();
app.use(express.json());

// Serve public static files EXCEPT control-panel.html
app.use((req, res, next) => {
  if (req.path === '/control-panel.html') return res.status(404).end();
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Tell frontend where admin panel lives (localhost only, but gear icon needs the port)
app.get('/api/admin-info', (_req, res) => {
  res.json({ port: ADMIN_PORT });
});

// --- SSE ---
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of clients) c.write(msg);
  // Also broadcast to admin SSE clients
  for (const c of adminClients) c.write(msg);
}

// --- Cards CRUD ---
app.get('/api/cards', (_req, res) => {
  res.json(cards.getAll());
});

app.post('/api/cards', (req, res) => {
  const { title, description, column } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const result = cards.create(title, description, column);
  const card = cards.get(Number(result.lastInsertRowid));
  broadcast('card-created', card);
  res.json(card);
});

app.put('/api/cards/:id', (req, res) => {
  const { title, description } = req.body;
  cards.update(Number(req.params.id), title, description);
  const card = cards.get(Number(req.params.id));
  broadcast('card-updated', card);
  res.json(card);
});

app.delete('/api/cards/:id', (req, res) => {
  const id = Number(req.params.id);
  snapshot.clear(id);
  cards.delete(id);
  broadcast('card-deleted', { id });
  res.json({ success: true });
});

app.post('/api/cards/:id/move', (req, res) => {
  const { column, source } = req.body;
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const fromColumn = card.column_name;
  if (fromColumn === column) return res.json(card);

  // Leaving working or todo (queued) -> dequeue/cancel
  var dequeueResult = { removed: false };
  if (fromColumn === 'working' || (fromColumn === 'todo' && card.status === 'queued')) {
    dequeueResult = orchestrator.dequeue(id);
    if (fromColumn === 'todo' && dequeueResult.removed) {
      cards.setStatus(id, 'idle');
    }
  }

  // Move the card
  cards.move(id, column);

  // Entering working -> enqueue build (if card has a spec)
  if (column === 'working' && card.spec) {
    try {
      orchestrator.enqueue(id, source === 'human' ? 1 : 0);
      return res.json(cards.get(id));
    } catch (err) {
      console.error('Enqueue failed for card', id, err.message);
      orchestrator.dequeue(id);
      cards.setStatus(id, 'idle');
      broadcast('card-updated', cards.get(id));
      broadcast('toast', { message: err.message, type: 'error' });
      return res.status(409).json({ error: err.message, card: cards.get(id) });
    }
  }

  // Moving to done -> approve + auto-commit + auto-archive overflow
  if (column === 'done') {
    cards.setStatus(id, 'complete');
    orchestrator.autoChangelog(id);
    orchestrator.autoCommit(id);
    autoArchiveDone();
    orchestrator.releaseProjectLock(id);
    orchestrator.checkUnblock();
  } else if (dequeueResult.wasBuilding) {
    cards.setStatus(id, 'interrupted');
  } else {
    cards.setStatus(id, 'idle');
  }

  broadcast('card-updated', cards.get(id));
  res.json(cards.get(id));
});

// --- Detect Project ---
app.post('/api/cards/:id/detect', (req, res) => {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const result = orchestrator.detectProject(card.title);
  res.json(result);
});

// --- Assign Folder ---
app.post('/api/cards/:id/assign-folder', (req, res) => {
  const id = Number(req.params.id);
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'projectPath required' });
  cards.setProjectPath(id, projectPath);
  const card = cards.get(id);
  broadcast('card-updated', card);
  res.json(card);
});

// --- Orchestrator Actions ---
app.post('/api/cards/:id/brainstorm', (req, res) => {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json({ success: true, message: 'Brainstorming started' });
  orchestrator.brainstorm(id).catch((err) => {
    broadcast('error', { cardId: id, message: err.message });
  });
});

app.post('/api/cards/:id/start-work', (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = orchestrator.startWork(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards/:id/open-vscode', (req, res) => {
  try {
    orchestrator.openInVSCode(Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards/:id/open-terminal', (req, res) => {
  try {
    orchestrator.openTerminal(Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards/:id/open-claude', (req, res) => {
  try {
    orchestrator.openClaude(Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (card && (!card.review_score || card.review_score === 0) && card.project_path) {
    try {
      const rcPath = path.join(card.project_path, '.review-complete');
      if (fs.existsSync(rcPath)) {
        const rc = JSON.parse(fs.readFileSync(rcPath, 'utf-8'));
        if (rc.score) cards.setReviewData(id, rc.score, JSON.stringify(rc));
      }
    } catch (_) { /* best effort */ }
  }
  cards.move(id, 'done');
  cards.setStatus(id, 'complete');
  cards.setApprovedBy(id, 'human');
  broadcast('card-updated', cards.get(id));
  const clResult = orchestrator.autoChangelog(id);
  if (clResult.success) {
    broadcast('toast', { message: 'Changelog: ' + clResult.type + ' entry added', type: 'success' });
  }
  const gitResult = orchestrator.autoCommit(id);
  if (gitResult.success && gitResult.action !== 'no-changes') {
    broadcast('toast', { message: 'Git: ' + gitResult.action, type: 'success' });
  }
  autoArchiveDone();
  orchestrator.releaseProjectLock(id);
  orchestrator.checkUnblock();
  res.json({ card: cards.get(id), git: gitResult, changelog: clResult });
});

app.post('/api/cards/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const result = snapshot.rollback(id);
  cards.move(id, 'todo');
  cards.setStatus(id, 'idle');
  cards.setSessionLog(id, 'REJECTED - Files rolled back. ' + (result.success ? (result.wasNew ? 'New project folder removed.' : 'All files restored to pre-work state.') : result.reason));
  broadcast('card-updated', cards.get(id));
  orchestrator.releaseProjectLock(id);
  const cascaded = orchestrator.cascadeRevert(id);
  res.json({ card: cards.get(id), rollback: result, cascaded: cascaded });
});

app.post('/api/cards/:id/edit-file', express.json({ limit: '5mb' }), (req, res) => {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card || !card.project_path) return res.status(404).json({ error: 'Card or project not found' });
  const { filePath, content } = req.body;
  if (!filePath || content === undefined) return res.status(400).json({ error: 'filePath and content required' });
  const fullPath = path.resolve(card.project_path, filePath);
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

app.post('/api/cards/:id/revert-files', (req, res) => {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (!snapshot.has(id)) return res.status(404).json({ error: 'No snapshot available for this card' });
  const result = snapshot.revert(id);
  if (result.success) {
    broadcast('toast', { message: 'Files reverted to pre-work state for: ' + card.title, type: 'success' });
    orchestrator.cascadeRevert(id);
  }
  res.json(result);
});

app.get('/api/cards/:id/has-snapshot', (req, res) => {
  res.json({ has: snapshot.has(Number(req.params.id)) });
});

app.get('/api/cards/:id/sessions', (req, res) => {
  res.json(sessions.getByCard(Number(req.params.id)));
});

// --- Logs API ---
app.get('/api/cards/:id/log/:type', (req, res) => {
  const logPath = path.join(LOGS_DIR, 'card-' + req.params.id + '-' + req.params.type + '.log');
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: 'No log found' });
  res.type('text/plain').send(fs.readFileSync(logPath, 'utf-8'));
});

// --- Self-Healing v2 ---
function scanLogsForErrors() {
  if (!fs.existsSync(LOGS_DIR)) return;
  var files;
  try { files = fs.readdirSync(LOGS_DIR); } catch (_) { return; }

  var errorPatterns = [
    /Error: (.+)/g, /ENOENT: (.+)/g, /EACCES: (.+)/g,
    /Cannot find module '(.+)'/g, /SyntaxError: (.+)/g, /TIMEOUT after/g,
  ];

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (!file.endsWith('.log')) continue;
    if (file.includes('-fix-') || file.includes('-review')) continue;

    var logFile = path.join(LOGS_DIR, file);
    var markerPath = logFile + '.scanned';
    if (fs.existsSync(markerPath)) continue;

    var content;
    try { content = fs.readFileSync(logFile, 'utf-8'); } catch (_) { continue; }
    if (!content.includes('completed') && !content.includes('TIMEOUT') && !content.includes('Error')) continue;

    var errors = [];
    for (var p = 0; p < errorPatterns.length; p++) {
      errorPatterns[p].lastIndex = 0;
      var match;
      while ((match = errorPatterns[p].exec(content)) !== null) {
        errors.push(match[0]);
      }
    }

    if (errors.length > 0) {
      var cardIdMatch = file.match(/card-(\d+)/);
      if (!cardIdMatch) continue;
      var sourceCardId = Number(cardIdMatch[1]);
      var uniqueErrors = [...new Set(errors)].slice(0, 10);
      var attempts = orchestrator.getFixAttempts(sourceCardId);

      if (attempts.count < 2) {
        var healResult = orchestrator.selfHeal(sourceCardId, uniqueErrors, logFile);
        if (healResult.status === 'fixing') {
          fs.appendFileSync(logFile, '\n[SELF-HEAL] Auto-fix attempt ' + healResult.attempt + ' started\n');
        } else if (healResult.status === 'max-attempts') {
          escalateToHuman(sourceCardId, uniqueErrors, file, logFile);
        }
      } else {
        escalateToHuman(sourceCardId, uniqueErrors, file, logFile);
      }
    }
    fs.writeFileSync(markerPath, new Date().toISOString());
  }
}

function escalateToHuman(sourceCardId, errors, file, logFile) {
  var sourceCard = cards.get(sourceCardId);
  var sourceTitle = sourceCard ? sourceCard.title : 'Card #' + sourceCardId;

  var existing = cards.getAll().find(function(c) {
    return c.title.includes('[Escalation]') && c.description && c.description.includes('card-' + sourceCardId);
  });
  if (existing) return;

  var fixTitle = '[Escalation] Auto-fix failed: ' + sourceTitle;
  var fixDesc = 'Self-healing failed after 2 attempts for card-' + sourceCardId + ' (' + file + '):\n\n'
    + errors.join('\n') + '\n\n'
    + 'Check fix logs: /api/cards/' + sourceCardId + '/log/fix-1 and /log/fix-2\n'
    + 'Original log: /api/cards/' + sourceCardId + '/log/' + (file.includes('brainstorm') ? 'brainstorm' : 'build')
    + '\n\nHuman intervention required.';

  var result = cards.create(fixTitle, fixDesc, 'brainstorm');
  var fixCard = cards.get(Number(result.lastInsertRowid));
  cards.setProjectPath(fixCard.id, path.join(__dirname));
  broadcast('card-created', cards.get(fixCard.id));
  broadcast('toast', { message: 'Escalation: Auto-fix failed for ' + sourceTitle, type: 'error' });
  fs.appendFileSync(logFile, '\n[SELF-HEAL] Escalated to human — created card #' + fixCard.id + '\n');
}

setInterval(scanLogsForErrors, 30000);

// --- Auto-Archive ---
function autoArchiveDone() {
  const doneCards = cards.getAll().filter(c => c.column_name === 'done');
  if (doneCards.length <= 5) return;
  doneCards.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const toArchive = doneCards.slice(5);
  for (const card of toArchive) {
    cards.move(card.id, 'archive');
    broadcast('card-deleted', { id: card.id });
  }
  if (toArchive.length > 0) {
    broadcast('toast', { message: toArchive.length + ' card(s) auto-archived', type: 'info' });
  }
  const deleted = cards.rotateArchive();
  for (const delId of deleted) {
    snapshot.clear(delId);
  }
}

// --- Archive API ---
app.get('/api/archive', (_req, res) => { res.json(cards.getArchived()); });

app.post('/api/cards/:id/unarchive', (req, res) => {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  cards.move(id, 'done');
  broadcast('card-created', cards.get(id));
  autoArchiveDone();
  res.json(cards.get(id));
});

// --- Queue / Activities / Pipeline (read-only, safe on public) ---
app.get('/api/queue', (_req, res) => { res.json(orchestrator.getQueueInfo()); });
app.get('/api/activities', (_req, res) => { res.json(orchestrator.getActivities()); });
app.get('/api/pipeline', (_req, res) => { res.json({ paused: orchestrator.isPaused() }); });

// --- Pipeline controls (needed by frontend on public port) ---
app.post('/api/pipeline/pause', (_req, res) => {
  orchestrator.setPaused(true);
  res.json({ paused: true });
});
app.post('/api/pipeline/resume', (_req, res) => {
  orchestrator.setPaused(false);
  res.json({ paused: false });
});
app.post('/api/cards/:id/stop', (req, res) => {
  try {
    const result = orchestrator.stopCard(Number(req.params.id));
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Review Data API ---
app.get('/api/cards/:id/review', (req, res) => {
  const card = cards.get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (!card.review_data) return res.json({ score: 0, findings: [] });
  try { res.json(JSON.parse(card.review_data)); }
  catch (_) { res.json({ score: card.review_score || 0, findings: [] }); }
});

// --- Live Log Stream (SSE) ---
app.get('/api/cards/:id/log-stream', (req, res) => {
  const id = req.params.id;
  const type = req.query.type || 'build';
  const logFile = path.join(LOGS_DIR, 'card-' + id + '-' + type + '.log');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
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

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 15000);

  const interval = setInterval(() => {
    try {
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (!fileFound) {
        fileFound = true;
        const content = fs.readFileSync(logFile, 'utf-8');
        res.write('data: ' + JSON.stringify({ type: 'initial', content: content }) + '\n\n');
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

  req.on('close', () => { clearInterval(interval); clearInterval(heartbeat); });
});

// --- Search / Spec / Labels / Deps / Diff / Retry / Preview ---
app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  res.json(cards.search(q));
});

app.put('/api/cards/:id/spec', (req, res) => {
  const id = Number(req.params.id);
  const { spec } = req.body;
  if (typeof spec !== 'string') return res.status(400).json({ error: 'spec required' });
  cards.setSpec(id, spec);
  const card = cards.get(id);
  broadcast('card-updated', card);
  res.json(card);
});

app.put('/api/cards/:id/labels', (req, res) => {
  const id = Number(req.params.id);
  const { labels } = req.body;
  if (typeof labels !== 'string') return res.status(400).json({ error: 'labels required' });
  cards.setLabels(id, labels);
  const card = cards.get(id);
  broadcast('card-updated', card);
  res.json(card);
});

app.put('/api/cards/:id/depends-on', (req, res) => {
  const id = Number(req.params.id);
  const { dependsOn } = req.body;
  if (typeof dependsOn !== 'string') return res.status(400).json({ error: 'dependsOn required' });
  cards.setDependsOn(id, dependsOn);
  const card = cards.get(id);
  broadcast('card-updated', card);
  res.json(card);
});

app.get('/api/cards/:id/diff', (req, res) => {
  const result = orchestrator.getDiff(Number(req.params.id));
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

app.post('/api/cards/:id/retry', (req, res) => {
  const id = Number(req.params.id);
  const { feedback } = req.body;
  if (!feedback) return res.status(400).json({ error: 'feedback required' });
  try {
    const result = orchestrator.retryWithFeedback(id, feedback);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards/:id/preview', (req, res) => {
  try {
    const result = orchestrator.previewProject(Number(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Export / Bulk Import / Metrics (on public for kanban board JS) ---
app.get('/api/export', (_req, res) => { res.json(orchestrator.exportBoard()); });

app.post('/api/bulk-create', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
  const created = [];
  for (const item of items.slice(0, 50)) {
    if (!item.title) continue;
    const result = cards.create(item.title, item.description || '', item.column || 'brainstorm');
    const card = cards.get(Number(result.lastInsertRowid));
    if (item.labels) cards.setLabels(card.id, item.labels);
    broadcast('card-created', cards.get(card.id));
    created.push(cards.get(card.id));
  }
  res.json({ created: created.length, cards: created });
});

app.get('/api/metrics', (_req, res) => { res.json(orchestrator.getMetrics()); });

// --- Test-only (NODE_ENV=test) ---
if (process.env.NODE_ENV === 'test') {
  app.put('/api/test/cards/:id/state', (req, res) => {
    const id = Number(req.params.id);
    const card = cards.get(id);
    if (!card) return res.status(404).json({ error: 'Not found' });
    cards.updateState(id, req.body);
    const updated = cards.get(id);
    broadcast('card-updated', updated);
    res.json(updated);
  });
}

// =============================================================================
// ADMIN APP — 127.0.0.1:ADMIN_PORT ONLY.
// Kernel rejects TCP SYN from non-loopback. No spoofing possible.
// =============================================================================
const adminApp = express();
adminApp.use(express.json());

// --- Admin SSE (mirrors main broadcast for real-time control panel updates) ---
const adminClients = new Set();

adminApp.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: connected\n\n');
  adminClients.add(res);
  req.on('close', () => adminClients.delete(res));
});

// --- PIN auth (optional extra layer even on localhost) ---
function pinCheck(req, res, next) {
  if (!ADMIN_PIN) return next();
  if (req.headers['x-admin-pin'] === ADMIN_PIN) return next();
  res.status(401).json({ error: 'Invalid admin PIN' });
}

adminApp.post('/api/admin/verify', (req, res) => {
  if (!ADMIN_PIN) return res.json({ ok: true, pinRequired: false });
  if (req.body.pin === ADMIN_PIN) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Invalid PIN' });
});

// --- Serve control panel at admin root ---
adminApp.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control-panel.html'));
});

// --- Read-only board data (so control panel avoids cross-origin to public server) ---
adminApp.get('/api/cards', (_req, res) => { res.json(cards.getAll()); });
adminApp.get('/api/queue', (_req, res) => { res.json(orchestrator.getQueueInfo()); });
adminApp.get('/api/activities', (_req, res) => { res.json(orchestrator.getActivities()); });
adminApp.get('/api/metrics', (_req, res) => { res.json(orchestrator.getMetrics()); });
adminApp.get('/api/pipeline', (_req, res) => { res.json({ paused: orchestrator.isPaused() }); });
adminApp.get('/api/export', (_req, res) => { res.json(orchestrator.exportBoard()); });
adminApp.get('/api/archive', (_req, res) => { res.json(cards.getArchived()); });

// --- Admin: usage ---
adminApp.get('/api/usage', (_req, res) => { res.json(orchestrator.getUsageStats()); });

adminApp.post('/api/usage/refresh', pinCheck, (_req, res) => {
  orchestrator.fetchClaudeUsage(true).then(function() {
    res.json(orchestrator.getUsageStats());
  });
});

// --- Admin: config ---
adminApp.get('/api/config', (_req, res) => { res.json(orchestrator.getConfig()); });

adminApp.put('/api/config', pinCheck, (req, res) => {
  const changed = orchestrator.setConfig(req.body);
  broadcast('toast', { message: 'Config updated: ' + Object.keys(changed).join(', '), type: 'success' });
  res.json({ changed, config: orchestrator.getConfig() });
});

// --- Admin: custom prompts ---
adminApp.get('/api/custom-prompts', (_req, res) => { res.json(orchestrator.getCustomPrompts()); });

adminApp.put('/api/custom-prompts', pinCheck, (req, res) => {
  const data = orchestrator.setCustomPrompts(req.body);
  broadcast('toast', { message: 'Custom prompts updated', type: 'success' });
  res.json(data);
});

// --- Admin: pipeline control ---
adminApp.post('/api/pipeline/pause', pinCheck, (_req, res) => {
  orchestrator.setPaused(true);
  res.json({ paused: true });
});

adminApp.post('/api/pipeline/resume', pinCheck, (_req, res) => {
  orchestrator.setPaused(false);
  res.json({ paused: false });
});

adminApp.post('/api/pipeline/kill-all', pinCheck, (_req, res) => {
  const killed = orchestrator.killAll();
  res.json({ killed });
});

adminApp.post('/api/cards/:id/stop', pinCheck, (req, res) => {
  try {
    const result = orchestrator.stopCard(Number(req.params.id));
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Admin: bulk import (write op, protected by PIN) ---
adminApp.post('/api/bulk-create', pinCheck, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
  const created = [];
  for (const item of items.slice(0, 50)) {
    if (!item.title) continue;
    const result = cards.create(item.title, item.description || '', item.column || 'brainstorm');
    const card = cards.get(Number(result.lastInsertRowid));
    if (item.labels) cards.setLabels(card.id, item.labels);
    broadcast('card-created', cards.get(card.id));
    created.push(cards.get(card.id));
  }
  res.json({ created: created.length, cards: created });
});

// =============================================================================
// START BOTH SERVERS
// =============================================================================
const PID_FILE = path.join(DATA_DIR, 'server.pid');

app.listen(PORT, '0.0.0.0', () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  orchestrator.init(broadcast);
  console.log('\n  Claude Kanban Board  http://localhost:' + PORT + '  (public, PID ' + process.pid + ')');
});

adminApp.listen(ADMIN_PORT, '127.0.0.1', () => {
  console.log('  Control Panel       http://localhost:' + ADMIN_PORT + '  (localhost-only' + (ADMIN_PIN ? ', PIN-protected' : '') + ')\n');
  var url = 'http://localhost:' + PORT;
  var openCmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(openCmd[0], openCmd[1], { stdio: 'ignore', windowsHide: true }).unref();
});

// Clean up PID file on exit
function removePidFile() { try { fs.unlinkSync(PID_FILE); } catch (_) {} }
process.on('exit', removePidFile);
process.on('SIGTERM', () => { removePidFile(); process.exit(0); });
process.on('SIGINT', () => { removePidFile(); process.exit(0); });
