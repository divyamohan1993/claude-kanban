const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PORT, ADMIN_PORT, ADMIN_PATH, ROOT_DIR, DATA_DIR, LOGS_DIR } = require('./config');
const { securityHeaders, requestId, originCheck, errorHandler, requireJsonContentType } = require('./middleware/security');
const { rateLimiter, sseGuard } = require('./middleware/rate-limit');
const { log } = require('./lib/logger');
const sso = require('./sso');
const { cards, auditLog, config: dbConfig, errors: dbErrors } = require('./db');
const { broadcast, setEnrichCard } = require('./lib/broadcast');
const pipeline = require('./services/pipeline');
const intelligence = require('./services/intelligence');
const publicRoutes = require('./routes/public');
setEnrichCard(publicRoutes.enrichCard);
const adminRoutes = require('./routes/admin');

// =============================================================================
// PUBLIC APP — 0.0.0.0:PORT — board UI + board APIs
// =============================================================================
const app = express();

// DDoS mitigation — FIRST, before Express parses anything.
// Token bucket: 60 req/s burst, 30/s refill per IP.
// Rejects with pre-built static 429 (~180 bytes). Zero processing on reject.
app.use(rateLimiter);

// SSE connection limiter — before the SSE route handlers (events + log-stream)
app.use('/api/events', sseGuard);
app.use('/api/cards/:id/log-stream', sseGuard);

app.use(securityHeaders);
app.use(requestId);
app.use(originCheck);
app.use(requireJsonContentType);
app.use(express.json({ limit: '1mb' }));

// SSO routes — /auth/login, /auth/logout, /auth/session (owned by src/sso/)
app.use(sso.routes);

// Block control-panel on public
app.use(function(req, res, next) {
  if (req.path === '/control-panel.html') return res.status(404).end();
  next();
});

// Cache busting — serve HTML with server-start timestamp (busts on every deploy/restart)
const BOOT_TS = Date.now();
const indexHtmlPath = path.join(ROOT_DIR, 'public', 'index.html');
app.get(['/', '/index.html'], function(req, res) {
  const html = fs.readFileSync(indexHtmlPath, 'utf8').replace(/__BUST__/g, String(BOOT_TS));
  res.type('html').send(html);
});

// Board is always public — no login gate. Auth is optional overlay.
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Health check — shallow liveness probe
app.get('/health', function(req, res) {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

// Deep health check — readiness probe: DB, disk, pipeline, errors
app.get('/health/ready', function(req, res) {
  const checks = {};
  let healthy = true;

  // DB connectivity
  try {
    const { db } = require('./db');
    db.pragma('integrity_check');
    checks.db = 'ok';
  } catch (err) {
    checks.db = 'fail: ' + err.message;
    healthy = false;
  }

  // Disk — check .data dir is writable
  try {
    const testFile = path.join(DATA_DIR, '.health-check');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    checks.disk = 'ok';
  } catch (err) {
    checks.disk = 'fail: ' + err.message;
    healthy = false;
  }

  // Pipeline state
  try {
    const pState = pipeline.getPipelineState();
    checks.pipeline = {
      status: pState.paused ? 'paused' : 'active',
      active: pState.activeCount,
      queued: pState.queuedCount,
      fixes: pState.fixCount,
    };
  } catch (err) {
    checks.pipeline = 'fail: ' + err.message;
    healthy = false;
  }

  // Unresolved errors
  try {
    const errCount = dbErrors.count();
    checks.errors = { unresolved: errCount };
    if (errCount > 50) checks.errors.warning = 'high unresolved error count';
  } catch (_) {
    checks.errors = { unresolved: 0 };
  }

  const status = healthy ? 200 : 503;
  res.status(status).json({
    status: healthy ? 'ready' : 'degraded',
    uptime: Math.round(process.uptime()),
    checks: checks,
  });
});

// Admin redirect — SSO-protected, requires admin role
// Path is auto-generated random hex (or pinned via ADMIN_PATH env)
app.get('/' + ADMIN_PATH, function(req, res) {
  const session = sso.verifySession(req);
  if (!session) return res.redirect('/auth/login?return=/' + ADMIN_PATH);
  if (session.user.role !== 'admin') return res.status(403).send('Admin access required');
  const adminPort = dbConfig.get('admin_port');
  if (!adminPort) return res.status(503).send('Admin server not ready');
  res.redirect('http://localhost:' + adminPort + '/');
});

// Public API routes
app.use(publicRoutes);

// Error handler
app.use(errorHandler);

// =============================================================================
// ADMIN APP — 127.0.0.1:ADMIN_PORT — kernel rejects non-loopback TCP
// =============================================================================
const adminApp = express();
adminApp.use(rateLimiter);
adminApp.use(securityHeaders);
adminApp.use(requestId);
adminApp.use(originCheck);
adminApp.use(requireJsonContentType);
adminApp.use(express.json({ limit: '1mb' }));

// SSO routes on admin app too
adminApp.use(sso.routes);

// Admin API routes
adminApp.use(adminRoutes);

// Error handler
adminApp.use(errorHandler);

// =============================================================================
// SELF-HEALING LOG SCANNER
// =============================================================================
function scanLogsForErrors() {
  if (!fs.existsSync(LOGS_DIR)) return;
  let files;
  try { files = fs.readdirSync(LOGS_DIR); } catch (_) { return; }

  const errorPatterns = [
    /Error: (.+)/g, /ENOENT: (.+)/g, /EACCES: (.+)/g,
    /Cannot find module '(.+)'/g, /SyntaxError: (.+)/g, /TIMEOUT after/g,
  ];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file.endsWith('.log')) continue;
    if (file.includes('-fix-') || file.includes('-review')) continue;

    const logFile = path.join(LOGS_DIR, file);
    // Track scanned files in DB instead of .scanned marker files
    if (dbConfig.get('scanned:' + file)) continue;

    let content;
    try { content = fs.readFileSync(logFile, 'utf-8'); } catch (_) { continue; }
    if (!content.includes('completed') && !content.includes('TIMEOUT') && !content.includes('Error')) continue;

    const errors = [];
    for (let p = 0; p < errorPatterns.length; p++) {
      errorPatterns[p].lastIndex = 0;
      let match;
      while ((match = errorPatterns[p]['exec'](content)) !== null) {
        errors.push(match[0]);
      }
    }

    if (errors.length > 0) {
      const cardIdMatch = file.match(/card-(\d+)/);
      if (!cardIdMatch) continue;
      const sourceCardId = Number(cardIdMatch[1]);
      const seen = {};
      const uniqueErrors = errors.filter(function(e) {
        if (seen[e]) return false;
        seen[e] = true;
        return true;
      }).slice(0, 10);
      const attempts = pipeline.getFixAttempts(sourceCardId);

      if (attempts.count < 2) {
        const healResult = pipeline.selfHeal(sourceCardId, uniqueErrors, logFile);
        if (healResult.status === 'fixing') {
          try { fs.appendFileSync(logFile, '\n[SELF-HEAL] Auto-fix attempt ' + healResult.attempt + ' started\n'); } catch (_) {}
        } else if (healResult.status === 'max-attempts') {
          escalateToHuman(sourceCardId, uniqueErrors, file, logFile);
        }
      } else {
        escalateToHuman(sourceCardId, uniqueErrors, file, logFile);
      }
    }
    dbConfig.set('scanned:' + file, new Date().toISOString());
  }
}

function escalateToHuman(sourceCardId, errors, file, logFile) {
  const sourceCard = cards.get(sourceCardId);
  const sourceTitle = sourceCard ? sourceCard.title : 'Card #' + sourceCardId;

  const existing = cards.getAll().find(function(c) {
    return c.title.includes('[Escalation]') && c.description && c.description.includes('card-' + sourceCardId);
  });
  if (existing) return;

  const fixTitle = '[Escalation] Auto-fix failed: ' + sourceTitle;
  const fixDesc = 'Self-healing failed after 2 attempts for card-' + sourceCardId + ' (' + file + '):\n\n'
    + errors.join('\n') + '\n\n'
    + 'Check fix logs: /api/cards/' + sourceCardId + '/log/fix-1 and /log/fix-2\n'
    + 'Original log: /api/cards/' + sourceCardId + '/log/' + (file.includes('brainstorm') ? 'brainstorm' : 'build')
    + '\n\nHuman intervention required.';

  const result = cards.create(fixTitle, fixDesc, 'brainstorm');
  const fixCard = cards.get(Number(result.lastInsertRowid));
  cards.setProjectPath(fixCard.id, ROOT_DIR);
  broadcast('card-created', cards.get(fixCard.id));
  broadcast('toast', { message: 'Escalation: Auto-fix failed for ' + sourceTitle, type: 'error' });
  try { fs.appendFileSync(logFile, '\n[SELF-HEAL] Escalated to human — created card #' + fixCard.id + '\n'); } catch (_) {}
}

// =============================================================================
// DB ERROR AUTO-FIX — scans error_log table for unresolved pipeline errors
// =============================================================================
function scanDbErrors() {
  try {
    const unresolved = dbErrors.unresolved();
    if (unresolved.length === 0) return;

    // Group errors by card_id
    const byCard = {};
    for (let i = 0; i < unresolved.length; i++) {
      const e = unresolved[i];
      if (!e.card_id) continue;
      if (!byCard[e.card_id]) byCard[e.card_id] = [];
      byCard[e.card_id].push(e);
    }

    const cardIds = Object.keys(byCard);
    for (let ci = 0; ci < cardIds.length; ci++) {
      const cardId = Number(cardIds[ci]);
      const card = cards.get(cardId);
      if (!card) {
        // Card deleted — resolve orphaned errors
        dbErrors.resolveByCard(cardId);
        continue;
      }

      // Skip cards already being worked on or fixed
      if (card.status === 'building' || card.status === 'reviewing' || card.status === 'fixing') continue;

      const errorMsgs = byCard[cardId].map(function(e) { return e.message; });
      const seen = {};
      const unique = errorMsgs.filter(function(m) {
        if (seen[m]) return false;
        seen[m] = true;
        return true;
      }).slice(0, 10);

      const attempts = pipeline.getFixAttempts(cardId);
      if (attempts.count < 2) {
        const logFile = path.join(LOGS_DIR, 'card-' + cardId + '-build.log');
        const healResult = pipeline.selfHeal(cardId, unique, logFile);
        if (healResult.status === 'fixing') {
          log.info({ cardId, attempt: healResult.attempt, errors: unique.length }, 'DB auto-fix triggered');
        } else if (healResult.status === 'max-attempts') {
          // Mark all as resolved — escalation handles from here
          dbErrors.resolveByCard(cardId);
          escalateToHuman(cardId, unique, 'db-error-log', logFile);
        }
      } else {
        // Already exhausted fix attempts — resolve and escalate
        dbErrors.resolveByCard(cardId);
      }
    }

    // Prune old resolved errors (>30 days)
    dbErrors.prune(30);
  } catch (err) {
    log.error({ err: err.message }, 'scanDbErrors failed');
  }
}

// =============================================================================
// START BOTH SERVERS
// =============================================================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const publicServer = app.listen(PORT, '0.0.0.0', function() {
  // Store PID in DB instead of file
  dbConfig.set('server_pid', String(process.pid));
  pipeline.init();
  intelligence.init();

  // Start periodic tasks — scan both log files and DB error table
  setInterval(scanLogsForErrors, 30000);
  setInterval(scanDbErrors, 30000);

  // Intelligence: periodic pattern analysis every 30 minutes
  setInterval(function() {
    try { intelligence.analyzeAndTune(); } catch (err) {
      log.error({ err: err.message }, 'Intelligence analyzeAndTune failed');
    }
  }, 30 * 60 * 1000);

  // Housekeeping every 1 hour — in single-project mode: pause, wait idle, clean, resume
  setInterval(function() {
    const autoDiscover = require('./services/auto-discover');
    const isSingle = autoDiscover.isSingleProjectMode();

    if (isSingle) {
      autoDiscover.stopPeriodicDiscovery();
      pipeline.setPaused(true);
      let waitCount = 0;
      const waitInterval = setInterval(function() {
        waitCount++;
        const pState = pipeline.getPipelineState();
        const isIdle = pState.activeCount === 0 && pState.fixCount === 0;
        if (isIdle || waitCount >= 30) {
          clearInterval(waitInterval);
          adminRoutes.runHousekeeping();
          pipeline.setPaused(false);
          autoDiscover.startPeriodicDiscovery();
        }
      }, 10000);
    } else {
      adminRoutes.runHousekeeping();
    }
  }, 60 * 60 * 1000);

  log.info('Claude Kanban Board  http://localhost:' + PORT + '  (public, PID ' + process.pid + ')');
});

// Request timeouts — kill slowloris attacks.
// 30s for headers (slowloris), 120s for full request, 120s keep-alive.
publicServer.headersTimeout = 30000;
publicServer.requestTimeout = 120000;
publicServer.keepAliveTimeout = 120000;
publicServer.maxHeadersCount = 50;

const adminServer = adminApp.listen(ADMIN_PORT, '127.0.0.1', function() {
  // Store all server config in DB — single source of truth
  dbConfig.set('admin_port', String(ADMIN_PORT));
  dbConfig.set('admin_path', ADMIN_PATH);
  dbConfig.set('public_port', String(PORT));
  dbConfig.set('server_pid', String(process.pid));
  log.info('Control Panel       http://localhost:' + PORT + '/' + ADMIN_PATH + '  (localhost-only, SSO-protected)');
  log.info('Admin Direct        http://localhost:' + ADMIN_PORT + '/  (localhost-only)');
  const url = 'http://localhost:' + PORT;
  const openCmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(openCmd[0], openCmd[1], { stdio: 'ignore', windowsHide: true }).unref();
});
adminServer.headersTimeout = 30000;
adminServer.requestTimeout = 120000;
adminServer.keepAliveTimeout = 120000;
adminServer.maxHeadersCount = 50;

// L2 fix: Graceful shutdown — drain connections, close DB, kill builds, clear PID
const { db } = require('./db');
function clearPid() { try { dbConfig.set('server_pid', ''); } catch (_) {} }

function gracefulShutdown(signal) {
  log.info({ signal }, 'Shutdown received — draining...');
  try { pipeline.killAll(); } catch (_) {}
  publicServer.close(function() {
    adminServer.close(function() {
      clearPid();
      try { db.close(); } catch (_) {}
      log.info('Shutdown clean exit');
      process.exit(0);
    });
  });
  // Force exit after 5s if drain takes too long
  setTimeout(function() {
    log.error('Shutdown forced exit after 5s timeout');
    clearPid();
    try { db.close(); } catch (_) {}
    process.exit(1);
  }, 5000);
}

process.on('exit', clearPid);
process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });
