const express = require('express');
const fs = require('fs');
const path = require('path');
const { cards, sessions } = require('./db');
const orchestrator = require('./orchestrator');
const snapshot = require('./snapshot');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 51777;
const LOGS_DIR = path.join(__dirname, 'logs');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

  // Leaving working → dequeue/cancel
  var dequeueResult = { removed: false };
  if (fromColumn === 'working') {
    dequeueResult = orchestrator.dequeue(id);
  }

  // Move the card
  cards.move(id, column);

  // Entering working → enqueue build (if card has a spec)
  if (column === 'working' && card.spec) {
    try {
      orchestrator.enqueue(id, source === 'human' ? 1 : 0);
      return res.json(cards.get(id));
    } catch (err) {
      console.error('Enqueue failed for card', id, err.message);
      orchestrator.dequeue(id);
      cards.setStatus(id, 'idle');
      broadcast('card-updated', cards.get(id));
      return res.json(cards.get(id));
    }
  }

  // Moving to done → approve + auto-commit + auto-archive overflow
  if (column === 'done') {
    if (fromColumn === 'review') snapshot.clear(id);
    cards.setStatus(id, 'complete');
    orchestrator.autoChangelog(id);
    orchestrator.autoCommit(id);
    autoArchiveDone();
  } else if (dequeueResult.wasBuilding) {
    // Card was actively building — mark as interrupted
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
  snapshot.clear(id);
  cards.move(id, 'done');
  cards.setStatus(id, 'complete');
  broadcast('card-updated', cards.get(id));
  // Auto-changelog
  const clResult = orchestrator.autoChangelog(id);
  if (clResult.success) {
    broadcast('toast', { message: 'Changelog: ' + clResult.type + ' entry added', type: 'success' });
  }
  // Auto-commit to git (includes changelog update)
  const gitResult = orchestrator.autoCommit(id);
  if (gitResult.success && gitResult.action !== 'no-changes') {
    broadcast('toast', { message: 'Git: ' + gitResult.action, type: 'success' });
  }
  autoArchiveDone();
  res.json({ card: cards.get(id), git: gitResult, changelog: clResult });
});

app.post('/api/cards/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const result = snapshot.rollback(id);
  cards.move(id, 'todo');
  cards.setStatus(id, 'idle');
  cards.setSessionLog(id, 'REJECTED - Files rolled back. ' + (result.success ? (result.wasNew ? 'New project folder removed.' : 'All files restored to pre-work state.') : result.reason));
  broadcast('card-updated', cards.get(id));
  res.json({ card: cards.get(id), rollback: result });
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

// --- Self-Healing v2: auto-detect errors, auto-fix without human intervention ---
function scanLogsForErrors() {
  if (!fs.existsSync(LOGS_DIR)) return;
  var files;
  try { files = fs.readdirSync(LOGS_DIR); } catch (_) { return; }

  var errorPatterns = [
    /Error: (.+)/g,
    /ENOENT: (.+)/g,
    /EACCES: (.+)/g,
    /Cannot find module '(.+)'/g,
    /SyntaxError: (.+)/g,
    /TIMEOUT after/g,
  ];

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (!file.endsWith('.log')) continue;
    // Skip fix logs and review logs to avoid recursive heal loops
    if (file.includes('-fix-') || file.includes('-review')) continue;

    var logFile = path.join(LOGS_DIR, file);
    var markerPath = logFile + '.scanned';

    if (fs.existsSync(markerPath)) continue;

    var content;
    try { content = fs.readFileSync(logFile, 'utf-8'); } catch (_) { continue; }

    // Only scan completed/failed logs
    if (!content.includes('completed') && !content.includes('TIMEOUT') && !content.includes('Error')) continue;

    var errors = [];
    for (var p = 0; p < errorPatterns.length; p++) {
      errorPatterns[p].lastIndex = 0; // reset regex state
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

// --- Auto-Archive: keep latest 5 in Done, move rest to archive ---
function autoArchiveDone() {
  const doneCards = cards.getAll().filter(c => c.column_name === 'done');
  if (doneCards.length <= 5) return;
  // Sort by updated_at descending — keep 5 newest
  doneCards.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const toArchive = doneCards.slice(5);
  for (const card of toArchive) {
    cards.move(card.id, 'archive');
    broadcast('card-deleted', { id: card.id });
  }
  if (toArchive.length > 0) {
    broadcast('toast', { message: toArchive.length + ' card(s) auto-archived', type: 'info' });
  }
}

// --- Archive API ---
app.get('/api/archive', (_req, res) => {
  res.json(cards.getArchived());
});

app.post('/api/cards/:id/unarchive', (req, res) => {
  const id = Number(req.params.id);
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  cards.move(id, 'done');
  broadcast('card-created', cards.get(id));
  autoArchiveDone();
  res.json(cards.get(id));
});

// --- Queue API ---
app.get('/api/queue', (_req, res) => {
  res.json(orchestrator.getQueueInfo());
});

// --- Activities API (current pipeline activity per card) ---
app.get('/api/activities', (_req, res) => {
  res.json(orchestrator.getActivities());
});

// --- Review Data API ---
app.get('/api/cards/:id/review', (req, res) => {
  const card = cards.get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (!card.review_data) return res.json({ score: 0, findings: [] });
  try {
    res.json(JSON.parse(card.review_data));
  } catch (_) {
    res.json({ score: card.review_score || 0, findings: [] });
  }
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

  // Always send immediate connected message so frontend knows stream is alive
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

  // Send heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 15000);

  const interval = setInterval(() => {
    try {
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (!fileFound) {
        // File just appeared — send full content
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

// --- Test-only endpoint (NODE_ENV=test) ---
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

// --- Start ---
app.listen(PORT, () => {
  orchestrator.init(broadcast);
  console.log('\n  Claude Kanban Board running at http://localhost:' + PORT + '\n');
  var url = 'http://localhost:' + PORT;
  var openCmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(openCmd[0], openCmd[1], { stdio: 'ignore', windowsHide: true }).unref();
});
