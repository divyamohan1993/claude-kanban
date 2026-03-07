const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { cards, sessions } = require('./db');
const snapshot = require('./snapshot');

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || 'R:\\';
const KANBAN_DIR = __dirname;
const LOGS_DIR = path.join(KANBAN_DIR, 'logs');
const RUNTIME_DIR = path.join(KANBAN_DIR, '.runtime');

// Active pollers for build completion
const activePollers = new Map();
// Track spawned process PIDs so we can kill them on dequeue
const buildPids = new Map(); // cardId → pid

// --- Work Queue ---
// Per-project locking: only one build at a time per project_path.
// Cards targeting the same project wait in queue.
const workQueue = [];           // [{cardId, priority, projectPath, enqueuedAt}]
const activeBuilds = new Map(); // projectPath → cardId
var _broadcast = function() {};

// --- Self-Healing State ---
const fixAttempts = new Map();  // sourceCardId → {count, lastAttempt}
const activeFixes = new Set();  // sourceCardId set
var MAX_FIX_ATTEMPTS = 2;

// --- Review Fix State ---
const reviewFixAttempted = new Set();  // cardIds that already had one auto-fix cycle

// --- Live Activity Tracking ---
const cardActivity = new Map();  // cardId → { detail, step, timestamp }

function setActivity(cardId, step, detail) {
  var entry = { cardId: cardId, step: step, detail: detail, timestamp: Date.now() };
  cardActivity.set(cardId, entry);
  _broadcast('card-activity', entry);
}

function clearActivity(cardId) {
  cardActivity.delete(cardId);
  _broadcast('card-activity', { cardId: cardId, step: null, detail: null, timestamp: Date.now() });
}

function getActivities() {
  var result = {};
  for (var entry of cardActivity) {
    result[entry[0]] = entry[1];
  }
  return result;
}

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });

// --- Helpers ---

var NOISE_WORDS = new Set(['create', 'build', 'make', 'add', 'implement', 'develop', 'write',
  'a', 'an', 'the', 'new', 'project', 'app', 'application', 'website', 'site',
  'for', 'with', 'and', 'or', 'in', 'on', 'to', 'that', 'this', 'my', 'our',
  'feature', 'research', 'improve', 'update', 'fix']);

function suggestName(title) {
  var words = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  var meaningful = words.filter(function(w) { return !NOISE_WORDS.has(w) && w.length > 1; });
  if (meaningful.length === 0) meaningful = words.filter(function(w) { return w.length > 1; });
  var name = meaningful.join('-').replace(/[^a-z0-9-]/g, '').replace(/^-|-$/g, '').slice(0, 50);
  return name || 'project';
}

function sanitizeName(title) {
  return suggestName(title);
}

function logPath(cardId, type) {
  return path.join(LOGS_DIR, 'card-' + cardId + '-' + type + '.log');
}

// --- Project Detection ---

function detectProject(title) {
  var name = suggestName(title);
  var nameNoHyphens = name.replace(/-/g, '');
  var words = title.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 2; });

  var entries;
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(function(e) { return e.isDirectory(); })
      .map(function(e) { return e.name; })
      .filter(function(e) { return e !== '$RECYCLE.BIN' && e !== 'System Volume Information'; });
  } catch (_) { return { matches: [], suggestedName: name, meaningfulWords: words }; }

  var matches = [];

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var lower = entry.toLowerCase();
    var lowerNoHyphens = lower.replace(/-/g, '');
    var score = 0;

    if (lower === name || lowerNoHyphens === nameNoHyphens) score = 100;
    else if (lower.includes(name) || name.includes(lower)) score = 80;
    else {
      var matched = words.filter(function(w) { return lower.includes(w); }).length;
      if (words.length > 0 && matched >= Math.ceil(words.length * 0.5)) {
        score = Math.round((matched / words.length) * 60);
      }
    }

    if (score > 0) {
      var fullPath = path.join(PROJECTS_ROOT, entry);
      var fileCount = 0;
      try { fileCount = snapshot.walkDir(fullPath).length; } catch (_) {}
      matches.push({ name: entry, path: fullPath, score: score, files: fileCount });
    }
  }

  matches.sort(function(a, b) { return b.score - a.score; });
  return { matches: matches.slice(0, 8), suggestedName: name };
}

function analyzeProject(projectPath) {
  var files = snapshot.walkDir(projectPath);
  var analysis = ['Project: ' + path.basename(projectPath)];
  analysis.push('Location: ' + projectPath);
  analysis.push('Files: ' + files.length);
  analysis.push('');
  analysis.push('File tree:');
  var treeFiles = files.slice(0, 100);
  for (var i = 0; i < treeFiles.length; i++) {
    analysis.push('  ' + treeFiles[i]);
  }
  if (files.length > 100) analysis.push('  ... and ' + (files.length - 100) + ' more');

  var keyFiles = ['package.json', 'README.md', 'CLAUDE.md', '.env.example', 'tsconfig.json'];
  for (var k = 0; k < keyFiles.length; k++) {
    var fp = path.join(projectPath, keyFiles[k]);
    if (fs.existsSync(fp)) {
      try {
        var content = fs.readFileSync(fp, 'utf-8');
        analysis.push('');
        analysis.push('--- ' + keyFiles[k] + ' ---');
        analysis.push(content.slice(0, 2000));
      } catch (_) {}
    }
  }

  return analysis.join('\n');
}

// --- Silent Claude Runner ---

function runClaudeSilent(opts) {
  var batPath = path.join(RUNTIME_DIR, '.run-' + opts.id + '.bat');
  var lines = [
    '@echo off',
    'cd /d "' + opts.cwd + '"',
    'set CLAUDECODE=',
  ];

  var cliBase = 'claude --model claude-opus-4-6 --effort high --dangerously-skip-permissions';
  var escapedPrompt = opts.prompt.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');

  if (opts.stdoutFile) {
    lines.push(cliBase + ' -p "' + escapedPrompt + '" > "' + opts.stdoutFile + '" 2>> "' + opts.logFile + '"');
  } else {
    lines.push(cliBase + ' -p "' + escapedPrompt + '" >> "' + opts.logFile + '" 2>&1');
  }

  fs.writeFileSync(batPath, lines.join('\r\n'));

  var child = spawn('cmd', ['/c', batPath], {
    cwd: opts.cwd,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  var pid = child.pid || 0;
  if (opts.cardId) buildPids.set(opts.cardId, pid);

  return { pid: pid, batPath: batPath };
}

// --- Queue Management ---

function init(broadcastFn) {
  _broadcast = broadcastFn;
  resetStuckCards();
}

function resetStuckCards() {
  var all = cards.getAll();
  for (var i = 0; i < all.length; i++) {
    var c = all[i];
    if (c.status === 'queued' || c.status === 'building') {
      cards.setStatus(c.id, 'idle');
      if (c.column_name === 'working') {
        cards.move(c.id, 'todo');
      }
      _broadcast('card-updated', cards.get(c.id));
    } else if (c.status === 'reviewing') {
      // Review was interrupted by restart — leave in review column for human
      cards.setStatus(c.id, 'idle');
      _broadcast('card-updated', cards.get(c.id));
    }
  }
}

function enqueue(cardId, priority) {
  var card = cards.get(cardId);
  if (!card) throw new Error('Card not found');
  if (!card.spec) throw new Error('No spec — run brainstorm first');

  var projectPath = card.project_path;
  if (!projectPath) {
    projectPath = path.join(PROJECTS_ROOT, sanitizeName(card.title));
    cards.setProjectPath(cardId, projectPath);
  }

  // Already building this exact card
  for (var entry of activeBuilds) {
    if (entry[1] === cardId) return { status: 'already-building' };
  }

  // Already queued — bump priority if human overrides ai
  var existing = workQueue.find(function(q) { return q.cardId === cardId; });
  if (existing) {
    if (priority > existing.priority) {
      existing.priority = priority;
      sortQueue();
      broadcastQueuePositions();
    }
    return { status: 'queued', position: getQueuePosition(cardId) };
  }

  // Move to working column if not already there
  if (card.column_name !== 'working') {
    cards.move(cardId, 'working');
  }
  cards.setStatus(cardId, 'queued');
  setActivity(cardId, 'queue', 'Waiting in build queue...');

  workQueue.push({
    cardId: cardId,
    priority: priority,
    projectPath: projectPath,
    enqueuedAt: Date.now(),
  });
  sortQueue();

  _broadcast('card-updated', cards.get(cardId));
  broadcastQueuePositions();

  processQueue();

  return { status: 'queued', position: getQueuePosition(cardId) };
}

function dequeue(cardId) {
  // Remove from queue
  var idx = workQueue.findIndex(function(q) { return q.cardId === cardId; });
  if (idx >= 0) {
    workQueue.splice(idx, 1);
    broadcastQueuePositions();
    return { removed: true };
  }

  // If actively building, kill process, remove from active, stop polling
  for (var entry of activeBuilds) {
    if (entry[1] === cardId) {
      activeBuilds.delete(entry[0]);
      var poller = activePollers.get(cardId);
      if (poller) { clearInterval(poller); activePollers.delete(cardId); }
      // Kill the Claude CLI process tree
      var pid = buildPids.get(cardId);
      if (pid) {
        try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
        buildPids.delete(cardId);
      }
      processQueue();
      return { removed: true, wasBuilding: true };
    }
  }

  return { removed: false };
}

function sortQueue() {
  workQueue.sort(function(a, b) {
    if (a.priority !== b.priority) return b.priority - a.priority; // higher first
    return a.enqueuedAt - b.enqueuedAt; // older first
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
  _broadcast('queue-update', getQueueInfo());
}

function processQueue() {
  for (var i = 0; i < workQueue.length; i++) {
    var item = workQueue[i];
    // Skip if this project already has an active build
    if (activeBuilds.has(item.projectPath)) continue;

    // Start this build
    workQueue.splice(i, 1);
    try {
      executeWork(item.cardId, item.projectPath);
    } catch (err) {
      console.error('executeWork failed for card', item.cardId, ':', err.message);
      cards.setStatus(item.cardId, 'idle');
      cards.move(item.cardId, 'todo');
      _broadcast('card-updated', cards.get(item.cardId));
    }
    broadcastQueuePositions();
    return;
  }
}

// --- Execute Work (internal — called by processQueue) ---

function executeWork(cardId, projectPath) {
  var card = cards.get(cardId);
  if (!card) return;

  var isExisting = projectPath && fs.existsSync(projectPath);

  activeBuilds.set(projectPath, cardId);
  setActivity(cardId, 'snapshot', 'Taking file snapshot...');

  // Clean up stale completion marker from previous builds
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

  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath, { recursive: true });
  }

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
  claudeParts.push('**Complete or don\'t ship.** Every deliverable must work end-to-end. No "TODO: implement later" in user-facing paths. If scope must shrink, shrink features, never completeness.');
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

  fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), claudeParts.join('\n'));
  setActivity(cardId, 'build', 'CLAUDE.md written — launching Claude...');

  var log = logPath(cardId, 'build');
  var header = '[' + new Date().toISOString() + '] Build started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\n'
    + 'Mode: ' + (isExisting ? 'EXISTING' : 'NEW') + '\nSnapshot: ' + snapInfo.fileCount + ' files\n---\n';
  fs.writeFileSync(log, header);

  var buildPrompt = 'Read CLAUDE.md and complete the task as specified. You are an autonomous orchestrator with FULL access to all tools — use subagents, agent teams, web search, file operations, terminal commands — whatever it takes. Maximize parallelism. Think deeply. Deliver production-quality work. When fully done, create .task-complete file as instructed in CLAUDE.md.';

  runClaudeSilent({
    id: 'build-' + cardId,
    cardId: cardId,
    cwd: projectPath,
    prompt: buildPrompt,
    stdoutFile: null,
    logFile: log,
  });

  cards.setStatus(cardId, 'building');
  _broadcast('card-updated', cards.get(cardId));
  setActivity(cardId, 'build', 'Claude is coding...');

  pollForCompletion(cardId, projectPath);

  return { success: true, projectPath: projectPath, isExisting: isExisting, snapshotFiles: snapInfo.fileCount };
}

// --- Start Work (public API — enqueues with human priority) ---

function startWork(cardId) {
  return enqueue(cardId, 1);
}

// --- Brainstorm ---

function buildBrainstormPrompt(card) {
  var isExisting = card.project_path && fs.existsSync(card.project_path);
  var parts = [];
  parts.push('You are a senior software architect working through a Kanban board system.');
  parts.push('Your job: analyze this task and produce a detailed, buildable specification.');
  parts.push('');

  if (isExisting) {
    parts.push('## Existing Project');
    parts.push(analyzeProject(card.project_path));
    parts.push('');
    parts.push('## Requested Changes');
    parts.push(card.title);
    if (card.description) parts.push(card.description);
    parts.push('');
    parts.push('Create a specification for these changes. Include:');
    parts.push('1) What exists now (brief summary)');
    parts.push('2) What needs to change and why');
    parts.push('3) Files to modify/create with specific changes');
    parts.push('4) Step-by-step implementation plan');
    parts.push('5) Risks, edge cases, and rollback considerations');
  } else {
    parts.push('## New Project');
    parts.push('Project: ' + card.title);
    if (card.description) parts.push('Details: ' + card.description);
    parts.push('');
    parts.push('Create a full technical specification. Include:');
    parts.push('1) Project Overview — what it does, for whom, why it matters');
    parts.push('2) Core Features (MVP only)');
    parts.push('3) Tech Stack with justification');
    parts.push('4) Architecture and data flow');
    parts.push('5) File structure');
    parts.push('6) Step-by-step implementation plan');
    parts.push('7) Edge cases and risks');
  }

  parts.push('');
  parts.push('Be practical and specific. This spec will be given to an AI coding agent (Claude Code)');
  parts.push('that will build it autonomously. Make every instruction actionable.');
  parts.push('');
  parts.push('## Quality Gates (enforce these in the spec)');
  parts.push('- pnpm only (never npm/yarn)');
  parts.push('- YAGNI, DRY, KISS — no over-engineering, no premature abstraction');
  parts.push('- Security: zero trust, all input hostile, OWASP Top 10, parameterized queries, no innerHTML');
  parts.push('- Accessibility: WCAG 2.2 AA, semantic HTML, keyboard navigation, ARIA labels');
  parts.push('- Performance: cache-first, lazy loading, bundle < 200KB gzip');
  parts.push('- Frontend: distinctive UI — skeuomorphic depth, micro-interactions, never generic templates');
  parts.push('- Naming: files kebab-case, components PascalCase, vars camelCase, constants UPPER_SNAKE_CASE');
  parts.push('- Servers must use random high ports (49152-65535), never common ports (3000, 8080, etc.)');
  parts.push('- Complete or don\'t ship — every feature must work end-to-end, no TODOs in user-facing paths');
  parts.push('');
  parts.push('You have full access to all tools — read files, search code, explore the project. Use them to understand the codebase deeply before writing the spec.');
  parts.push('Output the complete specification as your final response text.');
  return parts.join('\n');
}

function brainstorm(cardId) {
  var card = cards.get(cardId);
  if (!card) throw new Error('Card not found');

  cards.setStatus(cardId, 'brainstorming');
  _broadcast('card-updated', cards.get(cardId));
  setActivity(cardId, 'spec', 'Generating specification...');

  var workDir = (card.project_path && fs.existsSync(card.project_path)) ? card.project_path : KANBAN_DIR;
  var prompt = buildBrainstormPrompt(card);
  var outputFile = path.join(RUNTIME_DIR, '.brainstorm-output-' + cardId);
  var log = logPath(cardId, 'brainstorm');

  try { fs.unlinkSync(outputFile); } catch (_) {}

  var header = '[' + new Date().toISOString() + '] Brainstorm started\n'
    + 'Card: ' + card.title + '\nWorkDir: ' + workDir + '\n---\n';
  fs.writeFileSync(log, header);

  var run = runClaudeSilent({
    id: 'brainstorm-' + cardId,
    cardId: cardId,
    cwd: workDir,
    prompt: prompt,
    stdoutFile: outputFile,
    logFile: log,
  });

  var session = sessions.create(cardId, 'brainstorm', run.pid);
  var sessionId = Number(session.lastInsertRowid);

  return new Promise(function(resolve, reject) {
    var attempts = 0;
    var maxAttempts = 360;

    var interval = setInterval(function() {
      attempts++;
      try {
        var cardNow = cards.get(cardId);
        if (!cardNow || cardNow.status !== 'brainstorming') {
          clearInterval(interval);
          return resolve({ success: false, reason: 'cancelled' });
        }

        if (fs.existsSync(outputFile)) {
          var content = fs.readFileSync(outputFile, 'utf-8').trim();
          if (content.length > 50) {
            clearInterval(interval);
            sessions.update(sessionId, 'completed', content);
            cards.setSpec(cardId, content);
            cards.setStatus(cardId, 'idle');
            cards.move(cardId, 'todo');
            setActivity(cardId, 'spec', 'Spec ready (' + Math.round(content.length / 1024) + ' KB)');
            _broadcast('card-updated', cards.get(cardId));
            try { fs.appendFileSync(log, '\n---\n[' + new Date().toISOString() + '] Brainstorm completed (' + content.length + ' chars)\n'); } catch (_) {}
            try { fs.unlinkSync(outputFile); } catch (_) {}
            try { fs.unlinkSync(run.batPath); } catch (_) {}

            // Auto-start work — zero-touch pipeline
            try {
              setActivity(cardId, 'queue', 'Spec complete — auto-starting build...');
              enqueue(cardId, 0); // AI priority
              _broadcast('toast', { message: 'Auto-starting build for: ' + cards.get(cardId).title, type: 'info' });
            } catch (autoErr) {
              console.error('Auto-start work failed for card', cardId, ':', autoErr.message);
              clearActivity(cardId);
            }

            resolve({ success: true });
          }
        }

        if (attempts >= maxAttempts) {
          clearInterval(interval);
          sessions.update(sessionId, 'failed', 'Timeout');
          cards.setStatus(cardId, 'idle');
          cards.setSessionLog(cardId, 'Brainstorm timed out after 30 minutes');
          setActivity(cardId, 'spec', 'Timed out after 30 minutes');
          _broadcast('card-updated', cards.get(cardId));
          fs.appendFileSync(log, '\n---\n[' + new Date().toISOString() + '] TIMEOUT\n');
          reject(new Error('Brainstorm timed out'));
        }
      } catch (_) {}
    }, 5000);
  });
}

// --- Polling ---

function pollForCompletion(cardId, projectPath) {
  var completionFile = path.join(projectPath, '.task-complete');
  var log = logPath(cardId, 'build');

  var interval = setInterval(function() {
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
      if (fs.existsSync(completionFile)) {
        clearInterval(interval);
        activePollers.delete(cardId);
        activeBuilds.delete(projectPath);
        buildPids.delete(cardId);
        needsQueueProcess = true;

        var content = fs.readFileSync(completionFile, 'utf-8');
        cards.setSessionLog(cardId, content);
        cards.setStatus(cardId, 'idle'); // Clear building status before move
        cards.move(cardId, 'review');
        setActivity(cardId, 'review', 'Build complete — starting AI review...');
        _broadcast('card-updated', cards.get(cardId));

        // Log append may fail on Windows if bat process still holds file handle
        try {
          fs.appendFileSync(log, '\n---\n[' + new Date().toISOString() + '] Build completed\n' + content + '\n');
        } catch (logErr) {
          console.error('Log append failed (file lock?):', logErr.message);
        }

        // Trigger AI Review Gate — must run even if log append failed
        try {
          autoReview(cardId);
        } catch (reviewErr) {
          console.error('autoReview failed for card', cardId, ':', reviewErr.message);
          try { fs.appendFileSync(log, '\n[ERROR] autoReview failed: ' + reviewErr.message + '\n'); } catch (_) {}
          cards.setStatus(cardId, 'idle');
          _broadcast('card-updated', cards.get(cardId));
          _broadcast('toast', { message: 'AI Review failed to start: ' + reviewErr.message, type: 'error' });
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

// --- Utility Actions ---

function openInVSCode(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  spawn('cmd', ['/c', 'code', card.project_path], { shell: true, detached: true, stdio: 'ignore' }).unref();
}

function openTerminal(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + card.project_path + '"'], {
    shell: true, detached: true, stdio: 'ignore',
  }).unref();
}

function openClaude(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + card.project_path + '" && set CLAUDECODE= && claude'], {
    shell: true, detached: true, stdio: 'ignore',
  }).unref();
}

// --- Auto Git Commit ---

function autoCommit(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) return { success: false, reason: 'No project path' };

  var projectPath = card.project_path;
  var log = logPath(cardId, 'build');
  var execFileSync = require('child_process').execFileSync;
  var execOpts = { cwd: projectPath, stdio: 'pipe', windowsHide: true, timeout: 30000 };

  try {
    // Init git repo if needed
    var isGitRepo = fs.existsSync(path.join(projectPath, '.git'));
    if (!isGitRepo) {
      execFileSync('git', ['init'], execOpts);
      var gitignorePath = path.join(projectPath, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n.task-complete\n.brainstorm-output-*\n');
      }
    }

    // Stage all changes
    execFileSync('git', ['add', '-A'], execOpts);

    // Check if there are changes to commit
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], execOpts);
      fs.appendFileSync(log, '\n[AUTO-GIT] No changes to commit\n');
      return { success: true, action: 'no-changes' };
    } catch (_) {
      // There are staged changes — continue to commit
    }

    // Commit
    var msg = 'feat: ' + card.title + '\n\nKanban card #' + cardId + ' — approved and auto-committed.\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>';
    execFileSync('git', ['commit', '-m', msg], execOpts);
    fs.appendFileSync(log, '\n[AUTO-GIT] Committed: ' + card.title + '\n');

    // Push if remote exists
    try {
      var remotes = execFileSync('git', ['remote'], execOpts).toString().trim();
      if (remotes) {
        var branch = execFileSync('git', ['branch', '--show-current'], execOpts).toString().trim() || 'main';
        execFileSync('git', ['push', 'origin', branch], execOpts);
        fs.appendFileSync(log, '[AUTO-GIT] Pushed to origin/' + branch + '\n');
        return { success: true, action: 'committed-and-pushed', branch: branch };
      }
    } catch (pushErr) {
      fs.appendFileSync(log, '[AUTO-GIT] Push failed: ' + pushErr.message + '\n');
    }

    return { success: true, action: 'committed' };
  } catch (err) {
    fs.appendFileSync(log, '\n[AUTO-GIT] Error: ' + err.message + '\n');
    return { success: false, reason: err.message };
  }
}

// --- Auto Changelog ---

function autoChangelog(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) return { success: false, reason: 'No project path' };

  var projectPath = card.project_path;
  var changelogPath = path.join(projectPath, 'CHANGELOG.md');
  var today = new Date().toISOString().slice(0, 10);
  var title = card.title || 'Untitled';

  // Build entry from task-complete data if available
  var summary = '';
  var completionFile = path.join(projectPath, '.task-complete');
  try {
    if (fs.existsSync(completionFile)) {
      var raw = fs.readFileSync(completionFile, 'utf-8').trim();
      var data = JSON.parse(raw);
      if (data.summary) summary = data.summary;
      else if (data.message) summary = data.message;
    }
  } catch (_) { /* ignore parse errors */ }

  if (!summary) summary = card.description ? card.description.split('\n')[0] : title;

  // Determine change type from title prefix
  var changeType = 'Changed';
  var lowerTitle = title.toLowerCase();
  if (lowerTitle.startsWith('fix') || lowerTitle.includes('bug')) changeType = 'Fixed';
  else if (lowerTitle.startsWith('add') || lowerTitle.startsWith('new') || lowerTitle.startsWith('create')) changeType = 'Added';
  else if (lowerTitle.startsWith('remove') || lowerTitle.startsWith('delete')) changeType = 'Removed';

  var entry = '- ' + title + (summary !== title ? ' — ' + summary : '');

  try {
    var existing = '';
    if (fs.existsSync(changelogPath)) {
      existing = fs.readFileSync(changelogPath, 'utf-8');
    }

    // Check if today's date section exists
    var dateHeader = '## [' + today + ']';
    var typeHeader = '### ' + changeType;

    if (existing.includes(dateHeader)) {
      // Date section exists — find it and add entry under correct type
      var dateIdx = existing.indexOf(dateHeader);
      var afterDate = existing.indexOf('\n', dateIdx) + 1;
      var nextDateIdx = existing.indexOf('\n## [', afterDate);
      var dateSection = nextDateIdx === -1 ? existing.slice(afterDate) : existing.slice(afterDate, nextDateIdx);

      if (dateSection.includes(typeHeader)) {
        // Type header exists — append entry after it
        var typeIdx = existing.indexOf(typeHeader, dateIdx);
        var afterType = existing.indexOf('\n', typeIdx) + 1;
        existing = existing.slice(0, afterType) + entry + '\n' + existing.slice(afterType);
      } else {
        // Add new type section under this date
        existing = existing.slice(0, afterDate) + '\n' + typeHeader + '\n' + entry + '\n' + existing.slice(afterDate);
      }
      fs.writeFileSync(changelogPath, existing);
    } else {
      // New date section at top (after header if exists)
      var newSection = dateHeader + '\n\n' + typeHeader + '\n' + entry + '\n';
      if (existing) {
        var insertIdx = existing.indexOf('\n## [');
        if (insertIdx === -1) insertIdx = existing.indexOf('\n---');
        if (insertIdx === -1) {
          // Append after the first header line
          var firstNewline = existing.indexOf('\n');
          insertIdx = firstNewline === -1 ? existing.length : firstNewline + 1;
        }
        existing = existing.slice(0, insertIdx) + '\n' + newSection + '\n' + existing.slice(insertIdx);
      } else {
        existing = '# Changelog\n\n' + newSection;
      }
      fs.writeFileSync(changelogPath, existing);
    }

    return { success: true, entry: entry, type: changeType };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// --- Self-Healing ---

function selfHeal(sourceCardId, errors, sourceLogFile) {
  if (activeFixes.has(sourceCardId)) return { status: 'already-fixing' };

  var attempts = fixAttempts.get(sourceCardId) || { count: 0, lastAttempt: 0 };
  if (attempts.count >= MAX_FIX_ATTEMPTS) return { status: 'max-attempts', count: attempts.count };

  var card = cards.get(sourceCardId);
  if (!card || !card.project_path) return { status: 'no-project' };
  if (!fs.existsSync(card.project_path)) return { status: 'project-missing' };

  // Don't fix if card's project is currently being built
  if (activeBuilds.has(card.project_path)) return { status: 'build-active' };

  activeFixes.add(sourceCardId);
  attempts.count++;
  attempts.lastAttempt = Date.now();
  fixAttempts.set(sourceCardId, attempts);

  var projectPath = card.project_path;
  var fixLog = logPath(sourceCardId, 'fix-' + attempts.count);
  var fixFile = path.join(projectPath, '.fix-complete');

  try { fs.unlinkSync(fixFile); } catch (_) {}

  var header = '[' + new Date().toISOString() + '] Self-heal attempt ' + attempts.count + '/' + MAX_FIX_ATTEMPTS + '\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\nErrors: ' + errors.length + '\n---\n';
  fs.writeFileSync(fixLog, header);

  // Read the source log for context
  var logContext = '';
  try {
    if (sourceLogFile && fs.existsSync(sourceLogFile)) {
      var logContent = fs.readFileSync(sourceLogFile, 'utf-8');
      logContext = logContent.slice(-3000); // last 3KB for context
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

  runClaudeSilent({
    id: 'fix-' + sourceCardId + '-' + attempts.count,
    cardId: sourceCardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: fixLog,
  });

  // Poll for fix completion
  var pollCount = 0;
  var maxPoll = 120; // 10 minutes at 5s intervals

  var interval = setInterval(function() {
    pollCount++;
    try {
      if (fs.existsSync(fixFile)) {
        clearInterval(interval);
        activeFixes.delete(sourceCardId);

        var content = fs.readFileSync(fixFile, 'utf-8').trim();
        try {
          var data = JSON.parse(content);
          fs.appendFileSync(fixLog, '\n[SELF-HEAL] Result: ' + data.status + '\n');

          if (data.status === 'fixed') {
            fs.appendFileSync(fixLog, '[SELF-HEAL] Fixed: ' + (data.summary || 'No summary') + '\n');
            _broadcast('toast', { message: 'Self-healed: ' + card.title + ' — ' + (data.summary || 'Fixed'), type: 'success' });
            // Reset attempt counter on success
            fixAttempts.delete(sourceCardId);
          } else {
            fs.appendFileSync(fixLog, '[SELF-HEAL] Failed: ' + (data.reason || 'Unknown') + '\n');
            _broadcast('toast', { message: 'Self-heal failed: ' + (data.reason || 'Unknown'), type: 'error' });
          }
        } catch (_) {
          fs.appendFileSync(fixLog, '\n[SELF-HEAL] Invalid JSON in .fix-complete\n');
        }
        try { fs.unlinkSync(fixFile); } catch (_) {}
      }

      if (pollCount >= maxPoll) {
        clearInterval(interval);
        activeFixes.delete(sourceCardId);
        fs.appendFileSync(fixLog, '\n[SELF-HEAL] Timed out after 10 minutes\n');
        _broadcast('toast', { message: 'Self-heal timed out for: ' + card.title, type: 'error' });
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

// --- AI Review Gate ---

function autoReview(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) {
    console.error('autoReview: card', cardId, 'not found or no project_path');
    return;
  }

  var projectPath = card.project_path;
  if (!fs.existsSync(projectPath)) {
    console.error('autoReview: project path does not exist:', projectPath);
    return;
  }

  var reviewLog = logPath(cardId, 'review');
  var reviewFile = path.join(projectPath, '.review-complete');

  try { fs.unlinkSync(reviewFile); } catch (_) {}

  cards.setStatus(cardId, 'reviewing');
  _broadcast('card-updated', cards.get(cardId));
  setActivity(cardId, 'review', 'AI reviewer analyzing code...');

  var header = '[' + new Date().toISOString() + '] AI Review started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\n---\n';
  fs.writeFileSync(reviewLog, header);
  console.log('autoReview: started for card', cardId, '(' + card.title + ')');

  var prompt = [
    'You are a senior code reviewer. Review ALL code in this project thoroughly.',
    '',
    '## Check For',
    '1. Code quality: readability, DRY, KISS, single responsibility, no dead code',
    '2. Security: injection, XSS, CSRF, input validation, secrets in code, OWASP Top 10',
    '3. Performance: unnecessary loops, missing caching, large bundles, N+1 queries',
    '4. Accessibility: WCAG 2.2 AA, semantic HTML, ARIA labels, keyboard nav, color contrast',
    '5. Completeness: all features working, no TODO stubs, no placeholder content',
    '6. Error handling: proper boundaries, user-friendly messages, no swallowed errors',
    '',
    '## Scoring (1-10)',
    '- 9-10: Production ready, exemplary',
    '- 7-8: Good quality, minor improvements possible',
    '- 5-6: Acceptable, some issues need attention',
    '- 3-4: Significant problems',
    '- 1-2: Major rewrites needed',
    '',
    'Create .review-complete in the project root with this EXACT JSON format:',
    '{"score":NUMBER,"summary":"Brief overall assessment","findings":[{"severity":"critical|warning|info","category":"security|quality|performance|accessibility|completeness","message":"Description","file":"path/to/file"}],"autoApprove":BOOLEAN}',
    '',
    'Set autoApprove to true ONLY if score >= 8 AND zero critical findings.',
    'You have full access to all tools — read every file, search for patterns, run checks. Be thorough but fair.',
  ].join('\n');

  runClaudeSilent({
    id: 'review-' + cardId,
    cardId: cardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: reviewLog,
  });

  // Poll for review completion
  var pollCount = 0;
  var maxPoll = 180; // 15 minutes

  var reviewInterval = setInterval(function() {
    pollCount++;
    try {
      var cardNow = cards.get(cardId);
      if (!cardNow) {
        clearInterval(reviewInterval);
        return;
      }
      // Stop if card was manually moved away from review or status changed
      if (cardNow.status !== 'reviewing' && !fs.existsSync(reviewFile)) {
        clearInterval(reviewInterval);
        return;
      }

      if (fs.existsSync(reviewFile)) {
        clearInterval(reviewInterval);
        var content = fs.readFileSync(reviewFile, 'utf-8').trim();

        // Log append may fail on Windows if bat process still holds file handle
        try {
          fs.appendFileSync(reviewLog, '\n---\n[' + new Date().toISOString() + '] Review completed\n' + content + '\n');
        } catch (logErr) {
          console.error('Review log append failed (file lock?):', logErr.message);
        }

        try {
          var data = JSON.parse(content);
          var score = data.score || 0;
          var criticals = (data.findings || []).filter(function(f) { return f.severity === 'critical'; }).length;

          // Store review data
          cards.setReviewData(cardId, score, content);

          if (data.autoApprove && score >= 8 && criticals === 0) {
            // Auto-approve
            setActivity(cardId, 'approve', 'Score ' + score + '/10 — auto-approving...');
            cards.setStatus(cardId, 'complete');
            cards.move(cardId, 'done');
            snapshot.clear(cardId);
            _broadcast('card-updated', cards.get(cardId));
            _broadcast('toast', { message: 'AI Review: ' + score + '/10 — Auto-approved!', type: 'success' });

            setActivity(cardId, 'changelog', 'Updating changelog...');
            autoChangelog(cardId);
            setActivity(cardId, 'git', 'Git commit & push...');
            autoCommit(cardId);
            setActivity(cardId, 'done', 'Complete — score ' + score + '/10');
          } else if (score >= 5 && criticals === 0 && !reviewFixAttempted.has(cardId)) {
            // Score 5-7, no criticals — auto-fix findings then re-review
            reviewFixAttempted.add(cardId);
            var findingCount = (data.findings || []).length;
            setActivity(cardId, 'fix', 'Score ' + score + '/10 — auto-fixing ' + findingCount + ' findings...');
            cards.setStatus(cardId, 'fixing');
            _broadcast('card-updated', cards.get(cardId));
            _broadcast('toast', {
              message: 'AI Review: ' + score + '/10 — Auto-fixing ' + findingCount + ' findings...',
              type: 'info',
            });
            autoFixFindings(cardId, data.findings || []);
          } else {
            // Criticals or score < 5 or already attempted fix — human review
            setActivity(cardId, 'review', 'Score ' + score + '/10, ' + criticals + ' critical — needs human review');
            cards.setStatus(cardId, 'idle');
            _broadcast('card-updated', cards.get(cardId));
            _broadcast('toast', {
              message: 'AI Review: ' + score + '/10 — ' + criticals + ' critical. Human review needed.',
              type: score >= 5 ? 'info' : 'error',
            });
          }
        } catch (parseErr) {
          console.error('Review parse error:', parseErr.message);
          cards.setStatus(cardId, 'idle');
          _broadcast('card-updated', cards.get(cardId));
          try { fs.appendFileSync(reviewLog, '\n[REVIEW] Failed to parse review JSON: ' + parseErr.message + '\n'); } catch (_) {}
        }

        try { fs.unlinkSync(reviewFile); } catch (_) {}
      }

      if (pollCount >= maxPoll) {
        clearInterval(reviewInterval);
        cards.setStatus(cardId, 'idle');
        _broadcast('card-updated', cards.get(cardId));
        fs.appendFileSync(reviewLog, '\n[REVIEW] Timed out after 15 minutes\n');
        _broadcast('toast', { message: 'AI Review timed out for: ' + card.title, type: 'error' });
      }
    } catch (err) {
      console.error('autoReview poll error for card', cardId, ':', err.message);
    }
  }, 5000);
}

// --- Auto-Fix Review Findings ---

function autoFixFindings(cardId, findings) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) return;

  var projectPath = card.project_path;
  var fixLog = logPath(cardId, 'review-fix');
  var fixFile = path.join(projectPath, '.review-fix-complete');

  try { fs.unlinkSync(fixFile); } catch (_) {}

  var header = '[' + new Date().toISOString() + '] Auto-fix review findings started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath
    + '\nFindings: ' + findings.length + '\n---\n';
  fs.writeFileSync(fixLog, header);
  setActivity(cardId, 'fix', 'Claude fixing ' + findings.length + ' review findings...');
  console.log('autoFixFindings: started for card', cardId, '(' + findings.length + ' findings)');

  var findingsList = findings.map(function(f) {
    return '- [' + f.severity + '] ' + f.category + ': ' + f.message + (f.file ? ' (' + f.file + ')' : '');
  }).join('\n');

  var prompt = [
    'You are an autonomous code fixer. Fix ALL the review findings listed below.',
    '',
    '## Review Findings to Fix',
    findingsList,
    '',
    '## Instructions',
    '1. Read each file mentioned in the findings',
    '2. Fix each issue — do NOT break existing functionality',
    '3. For accessibility issues: fix color contrast, add ARIA labels, fix landmarks',
    '4. For security issues: fix input validation, encoding, CSP headers',
    '5. For quality issues: clean up code, remove dead code, fix naming',
    '6. Test that the application still works after your fixes',
    '',
    'When done, create .review-fix-complete in the project root:',
    '{"status":"fixed","summary":"What was fixed","files_changed":["list"]}',
  ].join('\n');

  runClaudeSilent({
    id: 'review-fix-' + cardId,
    cardId: cardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: fixLog,
  });

  // Poll for fix completion
  var pollCount = 0;
  var maxPoll = 120; // 10 minutes

  var fixInterval = setInterval(function() {
    pollCount++;
    try {
      if (fs.existsSync(fixFile)) {
        clearInterval(fixInterval);
        var content = fs.readFileSync(fixFile, 'utf-8').trim();
        try { fs.appendFileSync(fixLog, '\n---\n[' + new Date().toISOString() + '] Fix completed\n' + content + '\n'); } catch (_) {}

        try {
          var data = JSON.parse(content);
          console.log('autoFixFindings: completed for card', cardId, '—', data.summary || 'done');
          _broadcast('toast', { message: 'Auto-fix done: ' + (data.summary || 'Fixed findings'), type: 'success' });
        } catch (_) {}

        try { fs.unlinkSync(fixFile); } catch (_) {}

        // Re-review after fix
        setActivity(cardId, 'review', 'Fixes applied — re-reviewing...');
        autoReview(cardId);
      }

      if (pollCount >= maxPoll) {
        clearInterval(fixInterval);
        setActivity(cardId, 'fix', 'Auto-fix timed out — needs human review');
        cards.setStatus(cardId, 'idle');
        _broadcast('card-updated', cards.get(cardId));
        try { fs.appendFileSync(fixLog, '\n[FIX] Timed out after 10 minutes\n'); } catch (_) {}
        _broadcast('toast', { message: 'Auto-fix timed out. Human review needed.', type: 'error' });
      }
    } catch (err) {
      console.error('autoFixFindings poll error:', err.message);
    }
  }, 5000);
}

module.exports = {
  init: init,
  detectProject: detectProject,
  brainstorm: brainstorm,
  startWork: startWork,
  enqueue: enqueue,
  dequeue: dequeue,
  getQueueInfo: getQueueInfo,
  getActivities: getActivities,
  autoCommit: autoCommit,
  autoChangelog: autoChangelog,
  selfHeal: selfHeal,
  getFixAttempts: getFixAttempts,
  autoReview: autoReview,
  openInVSCode: openInVSCode,
  openTerminal: openTerminal,
  openClaude: openClaude,
  activePollers: activePollers,
};
