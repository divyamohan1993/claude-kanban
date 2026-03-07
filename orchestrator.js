const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cards, sessions, usage } = require('./db');
const snapshot = require('./snapshot');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || (IS_WIN ? 'R:\\' : path.join(os.homedir(), 'Projects'));
const KANBAN_DIR = __dirname;
const DATA_DIR = path.join(KANBAN_DIR, '.data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');

// --- Configurable Limits (mutable — runtime-editable via control panel) ---
var MAX_CONCURRENT_BUILDS = Number(process.env.MAX_CONCURRENT_BUILDS) || 1;
var BUILD_TIMEOUT_POLLS = Number(process.env.BUILD_TIMEOUT_MINS || 60) * 12; // 5s intervals — hard cap fallback
var IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MINS || 15) * 60 * 1000; // no log activity = stalled
var WEBHOOK_URL = process.env.WEBHOOK_URL || '';
var MAX_HOURLY_SESSIONS = Number(process.env.MAX_HOURLY_SESSIONS) || 0;   // 0 = unlimited
var MAX_WEEKLY_SESSIONS = Number(process.env.MAX_WEEKLY_SESSIONS) || 0;   // 0 = unlimited
var USAGE_PAUSE_PCT = Number(process.env.USAGE_PAUSE_PCT) || 80;         // auto-pause pipeline at this %
var MAX_DONE_VISIBLE = Number(process.env.MAX_DONE_VISIBLE) || 10;       // 0 = show all
var MAX_ARCHIVE_VISIBLE = Number(process.env.MAX_ARCHIVE_VISIBLE) || 50; // 0 = show all
var CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-6';
var CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || 'high';
var CUSTOM_PROMPTS_FILE = path.join(DATA_DIR, 'custom-prompts.json');

// Active pollers for build completion
const activePollers = new Map();
// Track spawned process PIDs so we can kill them on dequeue
const buildPids = new Map(); // cardId -> pid

// --- Work Queue ---
// Per-project locking: only one build at a time per project_path.
// Cards targeting the same project wait in queue.
const workQueue = [];           // [{cardId, priority, projectPath, enqueuedAt}]
const activeBuilds = new Map(); // projectPath -> cardId
var _broadcast = function() {};

// --- Pipeline Pause ---
var pipelinePaused = false;

function setPaused(paused) {
  pipelinePaused = !!paused;
  _broadcast('pipeline-state', { paused: pipelinePaused });
  sendWebhook('pipeline-' + (pipelinePaused ? 'paused' : 'resumed'), {});
  if (!pipelinePaused) {
    var allCards = cards.getAll();
    // Restart fix-interrupted cards at top priority (they have review_data with findings)
    for (var i = 0; i < allCards.length; i++) {
      var c = allCards[i];
      if (c.status === 'fix-interrupted' && c.column_name === 'todo') {
        try {
          var reviewData = c.review_data ? JSON.parse(c.review_data) : null;
          if (reviewData && reviewData.findings && reviewData.findings.length > 0) {
            cards.move(c.id, 'review');
            cards.setStatus(c.id, 'fixing');
            autoFixFindings(c.id, reviewData.findings);
          } else {
            // No findings data — enqueue as build at top priority
            cards.setStatus(c.id, 'idle');
            enqueue(c.id, 100); // highest priority
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
        try { brainstorm(allCards[j].id); } catch (_) {}
      }
    }
    processQueue(); // resume picks up queued builds
  }
}

function isPaused() { return pipelinePaused; }

// Kill all active builds + pause pipeline
function killAll() {
  pipelinePaused = true;
  var killed = [];

  // 1. Kill all active builds (working column)
  for (var entry of activeBuilds) {
    var projectPath = entry[0];
    var cardId = entry[1];
    var pid = buildPids.get(cardId);
    if (pid) { killProcess(pid); buildPids.delete(cardId); }
    var poller = activePollers.get(cardId);
    if (poller) { clearInterval(poller); activePollers.delete(cardId); }
    var card = cards.get(cardId);
    cards.setStatus(cardId, 'interrupted');
    cards.move(cardId, 'todo');
    setActivity(cardId, 'queue', 'Killed by master kill switch');
    _broadcast('card-updated', cards.get(cardId));
    killed.push({ id: cardId, title: card ? card.title : '?', phase: 'build' });
  }
  activeBuilds.clear();

  // 2. Freeze brainstorming cards — stay in brainstorm column, process killed
  var allCards = cards.getAll();
  for (var ci = 0; ci < allCards.length; ci++) {
    var c = allCards[ci];
    if (c.status === 'brainstorming') {
      var bPid = buildPids.get(c.id);
      if (bPid) { killProcess(bPid); buildPids.delete(c.id); }
      cards.setStatus(c.id, 'frozen');
      setActivity(c.id, 'spec', 'Frozen — will restart on resume');
      _broadcast('card-updated', cards.get(c.id));
      killed.push({ id: c.id, title: c.title, phase: 'brainstorm' });
    }
  }

  // 3. Kill all fixing processes — preserve review findings for auto-restart
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
      _broadcast('card-updated', cards.get(fc.id));
      killed.push({ id: fc.id, title: fc.title, phase: 'fix' });
    }
  }
  activeFixes.clear();

  // 4. Kill all review processes (review column, not fixing)
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
      _broadcast('card-updated', cards.get(rc.id));
      killed.push({ id: rc.id, title: rc.title, phase: 'review' });
    }
  }

  // 5. Clear remaining orphan pollers/pids
  for (var pollerEntry of activePollers) {
    clearInterval(pollerEntry[1]);
  }
  activePollers.clear();
  for (var pidEntry of buildPids) {
    killProcess(pidEntry[1]);
  }
  buildPids.clear();

  // 6. Drain the queue — move queued cards back to idle in todo
  while (workQueue.length > 0) {
    var qi = workQueue.pop();
    cards.setStatus(qi.cardId, 'idle');
    clearActivity(qi.cardId);
    _broadcast('card-updated', cards.get(qi.cardId));
  }

  broadcastQueuePositions();
  _broadcast('pipeline-state', { paused: true });
  _broadcast('toast', { message: 'Kill switch activated — ' + killed.length + ' process(es) terminated, pipeline paused', type: 'error' });
  sendWebhook('kill-all', { killed: killed });
  return killed;
}

// Stop a single card's active work
function stopCard(cardId) {
  var card = cards.get(cardId);
  if (!card) throw new Error('Card not found');

  var result = dequeue(cardId);

  // Also kill review/fix pollers
  var poller = activePollers.get(cardId);
  if (poller) { clearInterval(poller); activePollers.delete(cardId); }

  if (result.wasBuilding || result.removed) {
    cards.setStatus(cardId, 'interrupted');
    if (card.column_name === 'working') cards.move(cardId, 'todo');
    setActivity(cardId, 'queue', 'Manually stopped');
    _broadcast('card-updated', cards.get(cardId));
    _broadcast('toast', { message: 'Stopped: ' + card.title, type: 'warning' });
    return { stopped: true, wasBuilding: result.wasBuilding };
  }

  // Card might be in reviewing/fixing state with a poller but not in activeBuilds queue
  if (card.status === 'reviewing' || card.status === 'fixing') {
    releaseProjectLock(cardId);
    cards.setStatus(cardId, 'interrupted');
    if (card.column_name === 'working') cards.move(cardId, 'todo');
    setActivity(cardId, 'queue', 'Manually stopped');
    _broadcast('card-updated', cards.get(cardId));
    _broadcast('toast', { message: 'Stopped: ' + card.title, type: 'warning' });
    return { stopped: true, wasReviewing: true };
  }

  return { stopped: false, reason: 'Card not actively building or queued' };
}

// --- Self-Healing State ---
const fixAttempts = new Map();  // sourceCardId -> {count, lastAttempt}
const activeFixes = new Set();  // sourceCardId set
var MAX_FIX_ATTEMPTS = 2;

// --- Review Fix State ---
const reviewFixCount = new Map();  // cardId -> number of fix attempts (max 3)
var MAX_REVIEW_FIX_ATTEMPTS = 3;

// --- Live Activity Tracking ---
const cardActivity = new Map();  // cardId -> { detail, step, timestamp }

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

// --- Webhook ---
function sendWebhook(event, data) {
  if (!WEBHOOK_URL) return;
  try {
    var mod = WEBHOOK_URL.startsWith('https') ? require('https') : require('http');
    var url = new URL(WEBHOOK_URL);
    var payload = JSON.stringify({ event: event, data: data, timestamp: new Date().toISOString() });
    var req = mod.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, function() {});
    req.on('error', function() {});
    req.write(payload);
    req.end();
  } catch (_) {}
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
  return { matches: matches.slice(0, 8), suggestedName: name, projectsRoot: PROJECTS_ROOT };
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
  var scriptPath, lines;
  var cliBase = 'claude --model ' + CLAUDE_MODEL + ' --effort ' + CLAUDE_EFFORT + ' --dangerously-skip-permissions';

  if (IS_WIN) {
    scriptPath = path.join(RUNTIME_DIR, '.run-' + opts.id + '.bat');
    var escapedPrompt = opts.prompt.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
    lines = [
      '@echo off',
      'cd /d "' + opts.cwd + '"',
      'set CLAUDECODE=',
    ];
    if (opts.stdoutFile) {
      // stdout → output file for polling, stderr → log file
      // The brainstorm poller mirrors stdout content to the log for live transparency
      lines.push(cliBase + ' -p "' + escapedPrompt + '" > "' + opts.stdoutFile + '" 2>> "' + opts.logFile + '"');
    } else {
      lines.push(cliBase + ' -p "' + escapedPrompt + '" >> "' + opts.logFile + '" 2>&1');
    }
    fs.writeFileSync(scriptPath, lines.join('\r\n'));
  } else {
    scriptPath = path.join(RUNTIME_DIR, '.run-' + opts.id + '.sh');
    var escapedPrompt = opts.prompt.replace(/'/g, "'\\''").replace(/[\r\n]+/g, ' ');
    lines = [
      '#!/bin/bash',
      'cd "' + opts.cwd + '"',
      'unset CLAUDECODE',
    ];
    if (opts.stdoutFile) {
      // Tee stdout to both output file and log file for live transparency
      lines.push(cliBase + " -p '" + escapedPrompt + "' 2>> '" + opts.logFile + "' | tee '" + opts.stdoutFile + "' >> '" + opts.logFile + "'");
    } else {
      lines.push(cliBase + " -p '" + escapedPrompt + "' >> '" + opts.logFile + "' 2>&1");
    }
    fs.writeFileSync(scriptPath, lines.join('\n'), { mode: 0o755 });
  }

  var child = spawn(IS_WIN ? 'cmd' : 'bash', IS_WIN ? ['/c', scriptPath] : [scriptPath], {
    cwd: opts.cwd,
    stdio: 'ignore',
    windowsHide: true,
    detached: !IS_WIN,
  });
  child.unref();

  var pid = child.pid || 0;
  if (opts.cardId) buildPids.set(opts.cardId, pid);

  // Track usage for limit enforcement
  var usageType = (opts.id || '').replace(/-\d+.*$/, ''); // e.g. 'build', 'brainstorm', 'review'
  usage.log(usageType, opts.cardId || null);

  return { pid: pid, scriptPath: scriptPath };
}

// --- Claude Max Usage (real plan limits from API) ---

var _usageCache = { data: null, fetchedAt: 0 };
var USAGE_CACHE_TTL = 55 * 60 * 1000; // ~1 hour (conservative — avoid spam)

function fetchClaudeUsage(force) {
  // Return cached if fresh
  if (!force && _usageCache.data && (Date.now() - _usageCache.fetchedAt < USAGE_CACHE_TTL)) {
    return Promise.resolve(_usageCache.data);
  }

  var credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  var creds;
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  } catch (_) {
    return Promise.resolve(null);
  }

  var token = creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
  if (!token) return Promise.resolve(null);

  return new Promise(function(resolve) {
    var https = require('https');
    var req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        try {
          var data = JSON.parse(body);
          _usageCache.data = data;
          _usageCache.fetchedAt = Date.now();
          resolve(data);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(10000, function() { req.destroy(); resolve(null); });
    req.end();
  });
}

function checkUsageLimits() {
  // Self-imposed session limits
  var hourly = usage.hourly();
  var weekly = usage.weekly();
  var hitHourly = MAX_HOURLY_SESSIONS > 0 && hourly >= MAX_HOURLY_SESSIONS;
  var hitWeekly = MAX_WEEKLY_SESSIONS > 0 && weekly >= MAX_WEEKLY_SESSIONS;

  if (hitHourly || hitWeekly) {
    var reason = hitHourly
      ? 'Session limit reached (' + hourly + '/' + MAX_HOURLY_SESSIONS + '/hr)'
      : 'Weekly session limit reached (' + weekly + '/' + MAX_WEEKLY_SESSIONS + '/wk)';
    if (!pipelinePaused) {
      pipelinePaused = true;
      _broadcast('pipeline-state', { paused: true });
      _broadcast('toast', { message: 'Pipeline auto-paused: ' + reason, type: 'error' });
      sendWebhook('usage-limit', { reason: reason, hourly: hourly, weekly: weekly });
    }
    return { allowed: false, reason: reason };
  }

  // Real plan limits (from cache — non-blocking)
  var cached = _usageCache.data;
  if (cached) {
    var sessionPct = cached.five_hour ? cached.five_hour.utilization : 0;
    var weeklyPct = cached.seven_day ? cached.seven_day.utilization : 0;
    var overSession = sessionPct >= USAGE_PAUSE_PCT;
    var overWeekly = weeklyPct >= USAGE_PAUSE_PCT;

    if (overSession || overWeekly) {
      var reason = overSession
        ? 'Claude Max session at ' + sessionPct + '% (limit: ' + USAGE_PAUSE_PCT + '%)'
        : 'Claude Max weekly at ' + weeklyPct + '% (limit: ' + USAGE_PAUSE_PCT + '%)';
      if (!pipelinePaused) {
        pipelinePaused = true;
        _broadcast('pipeline-state', { paused: true });
        _broadcast('toast', { message: 'Pipeline auto-paused: ' + reason, type: 'error' });
        sendWebhook('usage-limit', { reason: reason, session: sessionPct, weekly: weeklyPct });
      }
      return { allowed: false, reason: reason };
    }
  }

  return { allowed: true };
}

function getUsageStats() {
  var planData = _usageCache.data;
  return {
    plan: planData ? {
      session: { utilization: planData.five_hour ? planData.five_hour.utilization : null, resetsAt: planData.five_hour ? planData.five_hour.resets_at : null },
      weekly: { utilization: planData.seven_day ? planData.seven_day.utilization : null, resetsAt: planData.seven_day ? planData.seven_day.resets_at : null },
      sonnet: planData.seven_day_sonnet ? { utilization: planData.seven_day_sonnet.utilization, resetsAt: planData.seven_day_sonnet.resets_at } : null,
      extraUsage: planData.extra_usage || null,
      pauseThreshold: USAGE_PAUSE_PCT,
      cachedAt: _usageCache.fetchedAt ? new Date(_usageCache.fetchedAt).toISOString() : null,
    } : null,
    board: {
      hourly: { count: usage.hourly(), limit: MAX_HOURLY_SESSIONS || null },
      weekly: { count: usage.weekly(), limit: MAX_WEEKLY_SESSIONS || null },
      hourlyBreakdown: usage.breakdown('-1 hour'),
      weeklyBreakdown: usage.breakdown('-7 days'),
    },
  };
}

// --- Runtime Configuration (control panel) ---

function getConfig() {
  return {
    runtime: {
      maxConcurrentBuilds: MAX_CONCURRENT_BUILDS,
      buildTimeoutMins: Math.round(BUILD_TIMEOUT_POLLS / 12),
      idleTimeoutMins: Math.round(IDLE_TIMEOUT_MS / 60000),
      usagePausePct: USAGE_PAUSE_PCT,
      maxHourlySessions: MAX_HOURLY_SESSIONS,
      maxWeeklySessions: MAX_WEEKLY_SESSIONS,
      maxReviewFixAttempts: MAX_REVIEW_FIX_ATTEMPTS,
      maxFixAttempts: MAX_FIX_ATTEMPTS,
      maxDoneVisible: MAX_DONE_VISIBLE,
      maxArchiveVisible: MAX_ARCHIVE_VISIBLE,
      claudeModel: CLAUDE_MODEL,
      claudeEffort: CLAUDE_EFFORT,
      webhookUrl: WEBHOOK_URL,
    },
    env: {
      port: process.env.PORT || 51777,
      projectsRoot: PROJECTS_ROOT,
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    },
    status: {
      pipelinePaused: pipelinePaused,
      activeBuilds: activeBuilds.size,
      queueLength: workQueue.length,
      activeFixes: activeFixes.size,
      activePollers: activePollers.size,
    },
  };
}

function setConfig(updates) {
  var changed = {};
  if (updates.maxConcurrentBuilds !== undefined) { MAX_CONCURRENT_BUILDS = Math.max(1, Number(updates.maxConcurrentBuilds)); changed.maxConcurrentBuilds = MAX_CONCURRENT_BUILDS; }
  if (updates.buildTimeoutMins !== undefined) { BUILD_TIMEOUT_POLLS = Math.max(1, Number(updates.buildTimeoutMins)) * 12; changed.buildTimeoutMins = Math.round(BUILD_TIMEOUT_POLLS / 12); }
  if (updates.idleTimeoutMins !== undefined) { IDLE_TIMEOUT_MS = Math.max(1, Number(updates.idleTimeoutMins)) * 60000; changed.idleTimeoutMins = Math.round(IDLE_TIMEOUT_MS / 60000); }
  if (updates.usagePausePct !== undefined) { USAGE_PAUSE_PCT = Math.max(1, Math.min(100, Number(updates.usagePausePct))); changed.usagePausePct = USAGE_PAUSE_PCT; }
  if (updates.maxHourlySessions !== undefined) { MAX_HOURLY_SESSIONS = Math.max(0, Number(updates.maxHourlySessions)); changed.maxHourlySessions = MAX_HOURLY_SESSIONS; }
  if (updates.maxWeeklySessions !== undefined) { MAX_WEEKLY_SESSIONS = Math.max(0, Number(updates.maxWeeklySessions)); changed.maxWeeklySessions = MAX_WEEKLY_SESSIONS; }
  if (updates.maxReviewFixAttempts !== undefined) { MAX_REVIEW_FIX_ATTEMPTS = Math.max(0, Number(updates.maxReviewFixAttempts)); changed.maxReviewFixAttempts = MAX_REVIEW_FIX_ATTEMPTS; }
  if (updates.maxFixAttempts !== undefined) { MAX_FIX_ATTEMPTS = Math.max(0, Number(updates.maxFixAttempts)); changed.maxFixAttempts = MAX_FIX_ATTEMPTS; }
  if (updates.maxDoneVisible !== undefined) { MAX_DONE_VISIBLE = Math.max(0, Number(updates.maxDoneVisible)); changed.maxDoneVisible = MAX_DONE_VISIBLE; }
  if (updates.maxArchiveVisible !== undefined) { MAX_ARCHIVE_VISIBLE = Math.max(0, Number(updates.maxArchiveVisible)); changed.maxArchiveVisible = MAX_ARCHIVE_VISIBLE; }
  if (updates.claudeModel !== undefined) { CLAUDE_MODEL = String(updates.claudeModel); changed.claudeModel = CLAUDE_MODEL; }
  if (updates.claudeEffort !== undefined) { CLAUDE_EFFORT = String(updates.claudeEffort); changed.claudeEffort = CLAUDE_EFFORT; }
  if (updates.webhookUrl !== undefined) { WEBHOOK_URL = String(updates.webhookUrl); changed.webhookUrl = WEBHOOK_URL; }
  _broadcast('config-updated', getConfig());
  return changed;
}

// --- Custom Prompts ---

function getCustomPrompts() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOM_PROMPTS_FILE, 'utf-8'));
  } catch (_) {
    return { buildInstructions: '', reviewCriteria: '', brainstormInstructions: '', qualityGates: '' };
  }
}

function setCustomPrompts(prompts) {
  var data = getCustomPrompts();
  if (prompts.buildInstructions !== undefined) data.buildInstructions = prompts.buildInstructions;
  if (prompts.reviewCriteria !== undefined) data.reviewCriteria = prompts.reviewCriteria;
  if (prompts.brainstormInstructions !== undefined) data.brainstormInstructions = prompts.brainstormInstructions;
  if (prompts.qualityGates !== undefined) data.qualityGates = prompts.qualityGates;
  fs.writeFileSync(CUSTOM_PROMPTS_FILE, JSON.stringify(data, null, 2));
  return data;
}

function killProcess(pid) {
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (_) {
    try { process.kill(pid, 'SIGKILL'); } catch (_2) {}
  }
}

// --- Queue Management ---

function init(broadcastFn) {
  _broadcast = broadcastFn;
  preflightChecks();
  resetStuckCards();

  // Initial usage fetch + periodic refresh (every 5 min)
  fetchClaudeUsage(true).then(function(data) {
    if (data) {
      console.log('  [usage] Claude Max: session ' + (data.five_hour ? data.five_hour.utilization : '?') + '%, weekly ' + (data.seven_day ? data.seven_day.utilization : '?') + '%');
      _broadcast('usage-update', getUsageStats());
    } else {
      console.log('  [usage] Could not fetch Claude Max usage (check ~/.claude/.credentials.json)');
    }
  });
  setInterval(function() {
    fetchClaudeUsage(true).then(function(data) {
      if (data) {
        _broadcast('usage-update', getUsageStats());
        checkUsageLimits();
      }
    });
  }, USAGE_CACHE_TTL);
}

// --- Preflight: verify all permissions/tools upfront so nothing fails midway ---
function preflightChecks() {
  var issues = [];
  var execFileSync = require('child_process').execFileSync;

  // 1. Ensure runtime + logs dirs exist and are writable
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

  // 2. Ensure projects root exists (create if missing on Mac/Linux)
  if (!IS_WIN && !fs.existsSync(PROJECTS_ROOT)) {
    try { fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); }
    catch (e) { issues.push('Cannot create projects dir ' + PROJECTS_ROOT + ': ' + e.message); }
  }

  // 3. Check Claude CLI is available
  try {
    execFileSync('claude', ['--version'], { timeout: 10000, stdio: 'pipe' });
  } catch (_) {
    issues.push('Claude CLI not found in PATH. Install: https://docs.anthropic.com/en/docs/claude-code');
  }

  // 4. Check VS Code CLI (non-fatal)
  try {
    execFileSync('code', ['--version'], { timeout: 5000, stdio: 'pipe' });
  } catch (_) {
    console.log('  [preflight] VS Code CLI not found — "Open in VSCode" will not work');
  }

  // 5. On macOS, verify shell scripts can be executed
  if (IS_MAC) {
    var testScript = path.join(RUNTIME_DIR, '.preflight-exec-test.sh');
    try {
      fs.writeFileSync(testScript, '#!/bin/bash\necho ok', { mode: 0o755 });
      execFileSync('bash', [testScript], { timeout: 5000, stdio: 'pipe' });
      fs.unlinkSync(testScript);
    } catch (e) {
      issues.push('Cannot execute shell scripts: ' + e.message);
    }
  }

  // 6. On Linux, check xdg-open for browser
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
      if (c.column_name === 'working') {
        cards.move(c.id, 'todo');
      }
      _broadcast('card-updated', cards.get(c.id));
    } else if (c.status === 'reviewing' || c.status === 'fixing') {
      // Review/fix was interrupted by restart — leave in review column for human
      cards.setStatus(c.id, 'idle');
      _broadcast('card-updated', cards.get(c.id));
    }
  }
}

function enqueue(cardId, priority) {
  var card = cards.get(cardId);
  if (!card) throw new Error('Card not found');
  if (!card.spec) throw new Error('No spec — run brainstorm first');

  // Check dependencies
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

  // Keep queued cards in todo — only move to working when actually building
  if (card.column_name !== 'todo' && card.column_name !== 'working') {
    cards.move(cardId, 'todo');
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
  sendWebhook('card-queued', { cardId: cardId, title: card.title });

  if (pipelinePaused) {
    setActivity(cardId, 'queue', 'Paused — waiting for resume');
  } else {
    processQueue();
  }

  return { status: 'queued', position: getQueuePosition(cardId), paused: pipelinePaused };
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
        killProcess(pid);
        buildPids.delete(cardId);
      }
      // Do NOT call processQueue() here — dequeue is always a manual action.
      // Automatic queue processing is handled by releaseProjectLock() and
      // pollForCompletion's needsQueueProcess flag in their respective flows.
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

// Release project lock after full pipeline (build+review+fix) completes
function releaseProjectLock(cardId) {
  var card = cards.get(cardId);
  if (!card) return;
  var projectPath = card.project_path;
  if (projectPath && activeBuilds.get(projectPath) === cardId) {
    activeBuilds.delete(projectPath);
    processQueue();
  }
}

// --- Revert Cascade ---
// When a card is reverted/rejected, find and stop all dependent cards.
// Independent cards are unaffected.
function cascadeRevert(revertedCardId) {
  var allCards = cards.getAll();
  var affected = [];

  for (var c of allCards) {
    if (!c.depends_on) continue;
    var deps = c.depends_on.split(',').map(function(d) { return Number(d.trim()); }).filter(Boolean);
    if (!deps.includes(revertedCardId)) continue;

    // This card depends on the reverted card
    var wasActive = false;
    if (c.status === 'building' || c.status === 'reviewing' || c.status === 'fixing' || c.status === 'queued') {
      // Kill active build/review if running
      var dqResult = dequeue(c.id);
      wasActive = dqResult.wasBuilding || dqResult.removed;
      // Also kill review pollers if reviewing
      var reviewPoller = activePollers.get(c.id);
      if (reviewPoller) { clearInterval(reviewPoller); activePollers.delete(c.id); }
    }

    if (c.column_name !== 'done' && c.column_name !== 'archive') {
      cards.setStatus(c.id, 'blocked');
      if (c.column_name !== 'todo') cards.move(c.id, 'todo');
      setActivity(c.id, 'queue', 'Blocked — dependency #' + revertedCardId + ' was reverted');
      _broadcast('card-updated', cards.get(c.id));
      affected.push({ id: c.id, title: c.title, wasActive: wasActive });
    }
  }

  if (affected.length > 0) {
    _broadcast('toast', {
      message: 'Reverted card #' + revertedCardId + ' — blocked ' + affected.length + ' dependent card(s)',
      type: 'error',
    });
    sendWebhook('cascade-revert', { revertedCardId: revertedCardId, affected: affected });
  }

  return affected;
}

// When a card completes (moves to done), check if any blocked cards can be unblocked
function checkUnblock() {
  var allCards = cards.getAll();
  var unblocked = [];

  for (var c of allCards) {
    if (c.status !== 'blocked') continue;
    if (!c.depends_on) { // No deps but blocked? Just unblock
      cards.setStatus(c.id, 'idle');
      clearActivity(c.id);
      _broadcast('card-updated', cards.get(c.id));
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
      _broadcast('card-updated', cards.get(c.id));
      _broadcast('toast', { message: 'Unblocked: ' + c.title, type: 'success' });
      unblocked.push(c.id);
    }
  }

  return unblocked;
}

function processQueue() {
  // Pipeline paused — nothing starts until user resumes
  if (pipelinePaused) return;
  // Usage limits — auto-pause if over threshold
  var limits = checkUsageLimits();
  if (!limits.allowed) return;
  // Global concurrency limit
  if (activeBuilds.size >= MAX_CONCURRENT_BUILDS) return;

  for (var i = 0; i < workQueue.length; i++) {
    var item = workQueue[i];
    // Skip if this project already has an active build
    if (activeBuilds.has(item.projectPath)) continue;

    // Check dependency satisfaction
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
    // Check if we can start more (up to concurrency limit)
    if (activeBuilds.size >= MAX_CONCURRENT_BUILDS) return;
    i--; // Re-check from same index since we spliced
  }
}

// --- Execute Work (internal — called by processQueue) ---

function executeWork(cardId, projectPath) {
  var card = cards.get(cardId);
  if (!card) return;

  var isExisting = projectPath && fs.existsSync(projectPath);

  // Move to working column now that build is actually starting
  if (card.column_name !== 'working') {
    cards.move(cardId, 'working');
    _broadcast('card-updated', cards.get(cardId));
  }
  activeBuilds.set(projectPath, cardId);
  setActivity(cardId, 'snapshot', 'Taking file snapshot...');
  trackPhase(cardId, 'build', 'start');

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

  // Append custom prompts if configured
  var cp = getCustomPrompts();
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
  sendWebhook('build-started', { cardId: cardId, title: card.title, projectPath: projectPath });

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

  // Append custom prompts if configured
  var cp = getCustomPrompts();
  if (cp.brainstormInstructions) {
    parts.push('');
    parts.push('## Additional Brainstorm Instructions');
    parts.push(cp.brainstormInstructions);
  }
  if (cp.qualityGates) {
    parts.push('');
    parts.push('## Additional Quality Gates');
    parts.push(cp.qualityGates);
  }

  return parts.join('\n');
}

function brainstorm(cardId) {
  var card = cards.get(cardId);
  if (!card) throw new Error('Card not found');

  cards.setStatus(cardId, 'brainstorming');
  _broadcast('card-updated', cards.get(cardId));
  setActivity(cardId, 'spec', 'Generating specification...');
  trackPhase(cardId, 'brainstorm', 'start');

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
    var lastMirroredSize = 0; // Track how much of stdout we've mirrored to log

    var interval = setInterval(function() {
      attempts++;
      try {
        var cardNow = cards.get(cardId);
        if (!cardNow || cardNow.status !== 'brainstorming') {
          clearInterval(interval);
          return resolve({ success: false, reason: 'cancelled' });
        }

        // Mirror stdout file content to log for live transparency (Windows only — Linux uses tee)
        if (IS_WIN && fs.existsSync(outputFile)) {
          try {
            var outStat = fs.statSync(outputFile);
            if (outStat.size > lastMirroredSize) {
              var fd = fs.openSync(outputFile, 'r');
              var buf = Buffer.alloc(outStat.size - lastMirroredSize);
              fs.readSync(fd, buf, 0, buf.length, lastMirroredSize);
              fs.closeSync(fd);
              fs.appendFileSync(log, buf.toString('utf-8'));
              lastMirroredSize = outStat.size;
            }
          } catch (_) {}
        }

        if (fs.existsSync(outputFile)) {
          var content = fs.readFileSync(outputFile, 'utf-8').trim();
          if (content.length > 50) {
            clearInterval(interval);
            trackPhase(cardId, 'brainstorm', 'end');
            sessions.update(sessionId, 'completed', content);
            cards.setSpec(cardId, content);
            cards.setStatus(cardId, 'idle');
            cards.move(cardId, 'todo');
            setActivity(cardId, 'spec', 'Spec ready (' + Math.round(content.length / 1024) + ' KB)');
            _broadcast('card-updated', cards.get(cardId));
            sendWebhook('brainstorm-complete', { cardId: cardId, title: card.title, specLength: content.length });
            try { fs.appendFileSync(log, '\n---\n[' + new Date().toISOString() + '] Brainstorm completed (' + content.length + ' chars)\n'); } catch (_) {}
            try { fs.unlinkSync(outputFile); } catch (_) {}
            try { fs.unlinkSync(run.scriptPath); } catch (_) {}

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
          trackPhase(cardId, 'brainstorm', 'end');
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

      // Activity-based timeout: only timeout if log file hasn't been written to
      // in IDLE_TIMEOUT_MS. Long-running active builds keep going.
      var isIdle = false;
      var idleMinutes = 0;
      try {
        var logStat = fs.statSync(log);
        var msSinceWrite = Date.now() - logStat.mtimeMs;
        idleMinutes = Math.round(msSinceWrite / 60000);
        isIdle = msSinceWrite > IDLE_TIMEOUT_MS;
      } catch (_) {
        // Log file doesn't exist yet — use poll count as fallback
        isIdle = pollCount >= BUILD_TIMEOUT_POLLS;
        idleMinutes = Math.round(pollCount * 5 / 60);
      }
      // Hard cap fallback — even active builds have an upper limit
      var hardTimeout = pollCount >= BUILD_TIMEOUT_POLLS * 4; // 4x the base (default 4 hours)

      if (isIdle || hardTimeout) {
        var reason = hardTimeout ? 'Hard limit (' + Math.round(pollCount * 5 / 60) + ' min)' : 'Idle for ' + idleMinutes + ' min (no log activity)';
        clearInterval(interval);
        activePollers.delete(cardId);
        activeBuilds.delete(projectPath);
        trackPhase(cardId, 'build', 'end');
        var pid = buildPids.get(cardId);
        if (pid) { killProcess(pid); buildPids.delete(cardId); }
        cards.setStatus(cardId, 'interrupted');
        _broadcast('card-updated', cards.get(cardId));
        setActivity(cardId, 'build', 'TIMEOUT — ' + reason);
        try { fs.appendFileSync(log, '\n---\n[' + new Date().toISOString() + '] TIMEOUT — ' + reason + '\n'); } catch (_) {}
        _broadcast('toast', { message: 'Build timed out (' + reason + '): ' + card.title, type: 'error' });
        sendWebhook('build-timeout', { cardId: cardId, title: card.title, reason: reason });
        needsQueueProcess = true;
        return;
      }

      if (fs.existsSync(completionFile)) {
        clearInterval(interval);
        activePollers.delete(cardId);
        // DO NOT release activeBuilds here — keep project locked until full
        // review cycle completes (build → review → fix → approve). This prevents
        // dependent cards from building on unreviewed/broken code.
        buildPids.delete(cardId);
        trackPhase(cardId, 'build', 'end');

        var content = fs.readFileSync(completionFile, 'utf-8');
        cards.setSessionLog(cardId, content);
        cards.setStatus(cardId, 'idle'); // Clear building status before move
        cards.move(cardId, 'review');
        setActivity(cardId, 'review', 'Build complete — starting AI review...');
        _broadcast('card-updated', cards.get(cardId));
        sendWebhook('build-complete', { cardId: cardId, title: card.title });

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
  if (!card || !card.project_path) throw new Error('No project path assigned');
  var child = spawn('code', [card.project_path], { shell: true, detached: true, stdio: 'ignore' });
  child.on('error', function(err) { console.error('VSCode spawn error:', err.message); });
  child.unref();
}

function openTerminal(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  var p = card.project_path;
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + p + '"'], { shell: true, detached: true, stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    spawn('open', ['-a', 'Terminal', p], { detached: true, stdio: 'ignore' }).unref();
  } else {
    var child = spawn('gnome-terminal', ['--working-directory=' + p], { detached: true, stdio: 'ignore' });
    child.on('error', function() {
      spawn('xterm', ['-e', 'bash'], { cwd: p, detached: true, stdio: 'ignore' }).unref();
    });
    child.unref();
  }
}

function openClaude(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  var p = card.project_path;
  var unsetEnv = IS_WIN ? 'set CLAUDECODE=' : 'unset CLAUDECODE';
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + p + '" && ' + unsetEnv + ' && claude'], { shell: true, detached: true, stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    spawn('osascript', ['-e', 'tell app "Terminal" to do script "cd \'' + p + '\' && ' + unsetEnv + ' && claude"'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    var child = spawn('gnome-terminal', ['--', 'bash', '-c', 'cd "' + p + '" && ' + unsetEnv + ' && claude; exec bash'], { detached: true, stdio: 'ignore' });
    child.on('error', function() {
      spawn('xterm', ['-e', 'bash -c \'cd "' + p + '" && ' + unsetEnv + ' && claude; exec bash\''], { detached: true, stdio: 'ignore' }).unref();
    });
    child.unref();
  }
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

  // Determine change type from title prefix or labels
  var changeType = 'Changed';
  var lowerTitle = title.toLowerCase();
  var labels = (card.labels || '').toLowerCase();
  if (labels.includes('bug') || lowerTitle.startsWith('fix') || lowerTitle.includes('bug')) changeType = 'Fixed';
  else if (labels.includes('feature') || lowerTitle.startsWith('add') || lowerTitle.startsWith('new') || lowerTitle.startsWith('create')) changeType = 'Added';
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
            sendWebhook('self-heal-success', { cardId: sourceCardId, summary: data.summary });
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
  trackPhase(cardId, 'review', 'start');

  var header = '[' + new Date().toISOString() + '] AI Review started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\n---\n';
  fs.writeFileSync(reviewLog, header);
  console.log('autoReview: started for card', cardId, '(' + card.title + ')');

  // Check for project-specific review criteria
  var customCriteria = '';
  var customReviewPath = path.join(projectPath, '.kanban-review.md');
  try {
    if (fs.existsSync(customReviewPath)) {
      customCriteria = fs.readFileSync(customReviewPath, 'utf-8').trim();
    }
  } catch (_) {}

  var promptParts = [
    'You are a senior code reviewer. Review ALL code in this project thoroughly.',
    '',
    '## Check For',
    '1. Code quality: readability, DRY, KISS, single responsibility, no dead code',
    '2. Security: injection, XSS, CSRF, input validation, secrets in code, OWASP Top 10',
    '3. Performance: unnecessary loops, missing caching, large bundles, N+1 queries',
    '4. Accessibility: WCAG 2.2 AA, semantic HTML, ARIA labels, keyboard nav, color contrast',
    '5. Completeness: all features working, no TODO stubs, no placeholder content',
    '6. Error handling: proper boundaries, user-friendly messages, no swallowed errors',
  ];

  if (customCriteria) {
    promptParts.push('');
    promptParts.push('## Project-Specific Review Criteria');
    promptParts.push(customCriteria);
  }

  promptParts.push('');
  promptParts.push('## Scoring (1-10)');
  promptParts.push('- 9-10: Production ready, exemplary');
  promptParts.push('- 7-8: Good quality, minor improvements possible');
  promptParts.push('- 5-6: Acceptable, some issues need attention');
  promptParts.push('- 3-4: Significant problems');
  promptParts.push('- 1-2: Major rewrites needed');
  promptParts.push('');
  promptParts.push('Create .review-complete in the project root with this EXACT JSON format:');
  promptParts.push('{"score":NUMBER,"summary":"Brief overall assessment","findings":[{"severity":"critical|warning|info","category":"security|quality|performance|accessibility|completeness","message":"Description","file":"path/to/file"}],"autoApprove":BOOLEAN,"needsHumanApproval":BOOLEAN}');
  promptParts.push('');
  promptParts.push('Set autoApprove to true ONLY if score >= 8 AND zero critical findings.');
  promptParts.push('Set needsHumanApproval to true ONLY for genuinely dangerous operations: destructive file deletions affecting production data, mass database changes, rm -rf of important directories, removing security controls. Normal code issues, missing features, or low scores do NOT need human approval — those get auto-fixed.');
  promptParts.push('You have full access to all tools — read every file, search for patterns, run checks. Be thorough but fair. Focus your review ONLY on what this specific card was supposed to build — do not penalize for features belonging to other cards/phases.');

  // Append custom prompts if configured
  var cp = getCustomPrompts();
  if (cp.reviewCriteria) {
    promptParts.push('');
    promptParts.push('## Additional Review Criteria');
    promptParts.push(cp.reviewCriteria);
  }

  var prompt = promptParts.join('\n');

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
        trackPhase(cardId, 'review', 'end');
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

          var fixCount = reviewFixCount.get(cardId) || 0;
          var needsHuman = data.needsHumanApproval === true; // Only for destructive/dangerous ops

          if (score >= 8 && criticals === 0 && !needsHuman) {
            // Auto-approve — score is good, no criticals, no dangerous ops
            reviewFixCount.delete(cardId);
            setActivity(cardId, 'approve', 'Score ' + score + '/10 — auto-approving...');
            cards.setStatus(cardId, 'complete');
            cards.setApprovedBy(cardId, 'ai');
            cards.move(cardId, 'done');
            snapshot.clear(cardId);
            _broadcast('card-updated', cards.get(cardId));
            _broadcast('toast', { message: 'AI Review: ' + score + '/10 — Auto-approved!', type: 'success' });
            sendWebhook('auto-approved', { cardId: cardId, title: card.title, score: score });

            setActivity(cardId, 'changelog', 'Updating changelog...');
            autoChangelog(cardId);
            setActivity(cardId, 'git', 'Git commit & push...');
            autoCommit(cardId);
            setActivity(cardId, 'done', 'Complete — score ' + score + '/10');
            releaseProjectLock(cardId);
            checkUnblock(); // Unblock cards that depended on this one
          } else if (needsHuman) {
            // Dangerous/destructive ops flagged — require human approval
            reviewFixCount.delete(cardId);
            setActivity(cardId, 'review', 'Score ' + score + '/10 — flagged for human approval (destructive ops)');
            cards.setStatus(cardId, 'idle');
            _broadcast('card-updated', cards.get(cardId));
            _broadcast('toast', {
              message: 'AI Review: Flagged for human approval — destructive operations detected.',
              type: 'error',
            });
            sendWebhook('review-needs-human', { cardId: cardId, title: card.title, score: score, reason: 'destructive_ops' });
            releaseProjectLock(cardId);
          } else if (fixCount < MAX_REVIEW_FIX_ATTEMPTS) {
            // Score < 8 — auto-fix findings and re-review (up to 3 attempts)
            reviewFixCount.set(cardId, fixCount + 1);
            var findingCount = (data.findings || []).length;
            setActivity(cardId, 'fix', 'Score ' + score + '/10 (attempt ' + (fixCount + 1) + '/' + MAX_REVIEW_FIX_ATTEMPTS + ') — auto-fixing ' + findingCount + ' findings...');
            cards.setStatus(cardId, 'fixing');
            _broadcast('card-updated', cards.get(cardId));
            _broadcast('toast', {
              message: 'AI Review: ' + score + '/10 — Auto-fixing (attempt ' + (fixCount + 1) + '/' + MAX_REVIEW_FIX_ATTEMPTS + ')...',
              type: 'info',
            });
            autoFixFindings(cardId, data.findings || []);
          } else {
            // Max fix attempts exhausted — human review as last resort
            reviewFixCount.delete(cardId);
            setActivity(cardId, 'review', 'Score ' + score + '/10 — ' + MAX_REVIEW_FIX_ATTEMPTS + ' fix attempts exhausted, needs human review');
            cards.setStatus(cardId, 'idle');
            _broadcast('card-updated', cards.get(cardId));
            _broadcast('toast', {
              message: 'AI Review: ' + score + '/10 — ' + MAX_REVIEW_FIX_ATTEMPTS + ' fix attempts exhausted. Human review needed.',
              type: 'error',
            });
            sendWebhook('review-needs-human', { cardId: cardId, title: card.title, score: score, criticals: criticals, reason: 'max_attempts' });
            releaseProjectLock(cardId);
          }
        } catch (parseErr) {
          console.error('Review parse error:', parseErr.message);
          cards.setStatus(cardId, 'idle');
          _broadcast('card-updated', cards.get(cardId));
          try { fs.appendFileSync(reviewLog, '\n[REVIEW] Failed to parse review JSON: ' + parseErr.message + '\n'); } catch (_) {}
          releaseProjectLock(cardId);
        }

        try { fs.unlinkSync(reviewFile); } catch (_) {}
      }

      if (pollCount >= maxPoll) {
        clearInterval(reviewInterval);
        trackPhase(cardId, 'review', 'end');
        cards.setStatus(cardId, 'idle');
        _broadcast('card-updated', cards.get(cardId));
        fs.appendFileSync(reviewLog, '\n[REVIEW] Timed out after 15 minutes\n');
        _broadcast('toast', { message: 'AI Review timed out for: ' + card.title, type: 'error' });
        releaseProjectLock(cardId);
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
        releaseProjectLock(cardId);
      }
    } catch (err) {
      console.error('autoFixFindings poll error:', err.message);
    }
  }, 5000);
}

// --- Retry with Feedback ---

function retryWithFeedback(cardId, feedback) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');

  var projectPath = card.project_path;

  // Take new snapshot (current state as new baseline)
  snapshot.take(cardId, projectPath);

  // Move to working
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

  runClaudeSilent({
    id: 'retry-' + cardId + '-' + Date.now(),
    cardId: cardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: log,
  });

  _broadcast('card-updated', cards.get(cardId));
  setActivity(cardId, 'build', 'Retrying with feedback...');
  sendWebhook('retry-started', { cardId: cardId, title: card.title, feedback: feedback });

  pollForCompletion(cardId, projectPath);

  return { success: true };
}

// --- Diff Viewer ---

function getDiff(cardId) {
  var snapDir = path.join(DATA_DIR, 'snapshots', 'card-' + cardId);
  var manifestPath = path.join(snapDir, '_manifest.json');
  if (!fs.existsSync(manifestPath)) return { error: 'No snapshot available' };

  var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  var projectPath = manifest.projectPath;

  if (!fs.existsSync(projectPath)) return { error: 'Project directory not found' };

  var originalFiles = new Set(manifest.files);
  var currentFiles;
  try { currentFiles = new Set(snapshot.walkDir(projectPath)); } catch (_) { currentFiles = new Set(); }

  var diff = { added: [], removed: [], modified: [], unchanged: 0, projectPath: projectPath };

  // Added files (in current but not in original) — include content for review
  for (var f of currentFiles) {
    if (!originalFiles.has(f)) {
      var addedPath = path.join(projectPath, f);
      try {
        var buf = fs.readFileSync(addedPath);
        var isText = !buf.includes(0);
        if (isText) {
          diff.added.push({ file: f, content: buf.toString('utf-8').slice(0, 50000), lines: buf.toString('utf-8').split('\n').length });
        } else {
          diff.added.push({ file: f, binary: true, size: buf.length });
        }
      } catch (_) {
        diff.added.push({ file: f, error: 'Could not read' });
      }
    }
  }

  // Removed files (in original but not in current)
  for (var f of originalFiles) {
    if (!currentFiles.has(f)) {
      diff.removed.push(f);
    }
  }

  // Modified/unchanged files
  for (var f of originalFiles) {
    if (!currentFiles.has(f)) continue;
    var origPath = path.join(snapDir, 'files', f);
    var currPath = path.join(projectPath, f);
    try {
      var origBuf = fs.readFileSync(origPath);
      var currBuf = fs.readFileSync(currPath);
      if (!origBuf.equals(currBuf)) {
        // Check if it's a text file (simple heuristic)
        var isText = !origBuf.includes(0) && !currBuf.includes(0);
        if (isText) {
          var origText = origBuf.toString('utf-8');
          var currText = currBuf.toString('utf-8');
          diff.modified.push({
            file: f,
            original: origText.slice(0, 50000),
            current: currText.slice(0, 50000),
            origLines: origText.split('\n').length,
            currLines: currText.split('\n').length,
          });
        } else {
          diff.modified.push({ file: f, binary: true, origSize: origBuf.length, currSize: currBuf.length });
        }
      } else {
        diff.unchanged++;
      }
    } catch (_) {
      diff.modified.push({ file: f, error: 'Could not read' });
    }
  }

  return diff;
}

// --- Preview / Run ---

function previewProject(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');

  var projectPath = card.project_path;
  var completionFile = path.join(projectPath, '.task-complete');
  var runCommand = null;

  try {
    if (fs.existsSync(completionFile)) {
      var data = JSON.parse(fs.readFileSync(completionFile, 'utf-8'));
      runCommand = data.run_command;
    }
  } catch (_) {}

  if (!runCommand) {
    // Try to detect from package.json
    var pkgPath = path.join(projectPath, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts) {
          if (pkg.scripts.dev) runCommand = 'pnpm dev';
          else if (pkg.scripts.start) runCommand = 'pnpm start';
          else if (pkg.scripts.preview) runCommand = 'pnpm preview';
        }
      }
    } catch (_) {}
  }

  if (!runCommand) throw new Error('No run command found in .task-complete or package.json');

  // Install deps + run command
  var fullCmd = 'pnpm install && ' + runCommand;
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + projectPath + '" && ' + fullCmd], { shell: true, detached: true, stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    spawn('osascript', ['-e', 'tell app "Terminal" to do script "cd \'' + projectPath + '\' && ' + fullCmd + '"'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('gnome-terminal', ['--', 'bash', '-c', 'cd "' + projectPath + '" && ' + fullCmd + '; exec bash'], { detached: true, stdio: 'ignore' }).unref();
  }

  return { success: true, command: runCommand };
}

// --- Export Board ---

function exportBoard() {
  var all = cards.getAll();
  var archived = cards.getArchived();
  return {
    exportedAt: new Date().toISOString(),
    version: '1.3.0',
    cards: all.map(function(c) {
      return {
        id: c.id, title: c.title, description: c.description, spec: c.spec,
        column: c.column_name, status: c.status, labels: c.labels, depends_on: c.depends_on,
        project_path: c.project_path, review_score: c.review_score,
        phase_durations: c.phase_durations, created_at: c.created_at, updated_at: c.updated_at,
      };
    }),
    archived: archived.map(function(c) {
      return {
        id: c.id, title: c.title, description: c.description, column: c.column_name,
        labels: c.labels, review_score: c.review_score, project_path: c.project_path,
        created_at: c.created_at, updated_at: c.updated_at,
      };
    }),
    sessions: sessions.getAll(),
    auditLog: require('./db').audit.all(),
  };
}

// --- Metrics ---

function getMetrics() {
  var all = cards.getAll().concat(cards.getArchived());
  var scores = [];
  var durations = { brainstorm: [], build: [], review: [] };
  var projectCounts = {};
  var completedByDay = {};
  var labelCounts = {};

  for (var i = 0; i < all.length; i++) {
    var card = all[i];

    if (card.project_path) {
      var proj = path.basename(card.project_path);
      projectCounts[proj] = (projectCounts[proj] || 0) + 1;
    }

    if (card.review_score > 0) scores.push(card.review_score);

    if (card.phase_durations) {
      try {
        var pd = JSON.parse(card.phase_durations);
        ['brainstorm', 'build', 'review'].forEach(function(phase) {
          if (pd[phase] && pd[phase].duration) durations[phase].push(pd[phase].duration);
        });
      } catch (_) {}
    }

    if (card.column_name === 'done' || card.column_name === 'archive') {
      var day = (card.updated_at || '').slice(0, 10);
      if (day) completedByDay[day] = (completedByDay[day] || 0) + 1;
    }

    if (card.labels) {
      card.labels.split(',').forEach(function(l) {
        l = l.trim();
        if (l) labelCounts[l] = (labelCounts[l] || 0) + 1;
      });
    }
  }

  function avg(arr) { return arr.length > 0 ? Math.round(arr.reduce(function(a, b) { return a + b; }, 0) / arr.length) : 0; }

  return {
    totalCards: all.length,
    avgReviewScore: scores.length > 0 ? Math.round(avg(scores) * 10) / 10 : 0,
    avgDurations: {
      brainstorm: Math.round(avg(durations.brainstorm) / 1000),
      build: Math.round(avg(durations.build) / 1000),
      review: Math.round(avg(durations.review) / 1000),
    },
    completedByDay: completedByDay,
    topProjects: Object.entries(projectCounts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10),
    labelDistribution: labelCounts,
    scoreDistribution: scores,
  };
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
  retryWithFeedback: retryWithFeedback,
  getDiff: getDiff,
  previewProject: previewProject,
  exportBoard: exportBoard,
  getMetrics: getMetrics,
  sendWebhook: sendWebhook,
  releaseProjectLock: releaseProjectLock,
  cascadeRevert: cascadeRevert,
  checkUnblock: checkUnblock,
  setPaused: setPaused,
  isPaused: isPaused,
  killAll: killAll,
  stopCard: stopCard,
  fetchClaudeUsage: fetchClaudeUsage,
  getUsageStats: getUsageStats,
  getConfig: getConfig,
  setConfig: setConfig,
  getCustomPrompts: getCustomPrompts,
  setCustomPrompts: setCustomPrompts,
};
