var express = require('express');
var fs = require('fs');
var path = require('path');
var { spawn } = require('child_process');
var { PORT, ADMIN_PORT, ROOT_DIR, DATA_DIR, LOGS_DIR } = require('./config');
var { securityHeaders, requestId, originCheck, errorHandler, requireJsonContentType } = require('./middleware/security');
var { rateLimiter, sseGuard } = require('./middleware/rate-limit');
var { cards, auditLog } = require('./db');
var { broadcast } = require('./lib/broadcast');
var pipeline = require('./services/pipeline');
var publicRoutes = require('./routes/public');
var adminRoutes = require('./routes/admin');

// =============================================================================
// PUBLIC APP — 0.0.0.0:PORT — board UI + board APIs
// =============================================================================
var app = express();

// DDoS mitigation — FIRST, before Express parses anything.
// Token bucket: 60 req/s burst, 30/s refill per IP.
// Rejects with pre-built static 429 (~180 bytes). Zero processing on reject.
app.use(rateLimiter);

// SSE connection limiter — before the SSE route handler
app.use('/api/events', sseGuard);

app.use(securityHeaders);
app.use(requestId);
app.use(originCheck);
app.use(requireJsonContentType);
app.use(express.json({ limit: '1mb' }));

// Block control-panel on public
app.use(function(req, res, next) {
  if (req.path === '/control-panel.html') return res.status(404).end();
  next();
});

// Static files
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Admin info — localhost-only, spoof-proof (checks socket address, not headers)
app.get('/api/admin-info', function(req, res) {
  var remote = req.socket.remoteAddress || '';
  var isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'Localhost only' });
  res.json({ port: ADMIN_PORT });
});

// Public API routes
app.use(publicRoutes);

// Error handler
app.use(errorHandler);

// =============================================================================
// ADMIN APP — 127.0.0.1:ADMIN_PORT — kernel rejects non-loopback TCP
// =============================================================================
var adminApp = express();
adminApp.use(rateLimiter);
adminApp.use(securityHeaders);
adminApp.use(requestId);
adminApp.use(originCheck);
adminApp.use(requireJsonContentType);
adminApp.use(express.json({ limit: '1mb' }));

// Admin API routes
adminApp.use(adminRoutes);

// Error handler
adminApp.use(errorHandler);

// =============================================================================
// SELF-HEALING LOG SCANNER
// =============================================================================
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
      while ((match = errorPatterns[p]['exec'](content)) !== null) {
        errors.push(match[0]);
      }
    }

    if (errors.length > 0) {
      var cardIdMatch = file.match(/card-(\d+)/);
      if (!cardIdMatch) continue;
      var sourceCardId = Number(cardIdMatch[1]);
      var seen = {};
      var uniqueErrors = errors.filter(function(e) {
        if (seen[e]) return false;
        seen[e] = true;
        return true;
      }).slice(0, 10);
      var attempts = pipeline.getFixAttempts(sourceCardId);

      if (attempts.count < 2) {
        var healResult = pipeline.selfHeal(sourceCardId, uniqueErrors, logFile);
        if (healResult.status === 'fixing') {
          try { fs.appendFileSync(logFile, '\n[SELF-HEAL] Auto-fix attempt ' + healResult.attempt + ' started\n'); } catch (_) {}
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
  cards.setProjectPath(fixCard.id, ROOT_DIR);
  broadcast('card-created', cards.get(fixCard.id));
  broadcast('toast', { message: 'Escalation: Auto-fix failed for ' + sourceTitle, type: 'error' });
  try { fs.appendFileSync(logFile, '\n[SELF-HEAL] Escalated to human — created card #' + fixCard.id + '\n'); } catch (_) {}
}

// =============================================================================
// START BOTH SERVERS
// =============================================================================
var PID_FILE = path.join(DATA_DIR, 'server.pid');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

var publicServer = app.listen(PORT, '0.0.0.0', function() {
  fs.writeFileSync(PID_FILE, String(process.pid));
  pipeline.init();

  // Start periodic tasks
  setInterval(scanLogsForErrors, 30000);
  setInterval(function() { adminRoutes.runHousekeeping(); }, 30 * 60 * 1000);

  console.log('\n  Claude Kanban Board  http://localhost:' + PORT + '  (public, PID ' + process.pid + ')');
});

// Request timeouts — kill slowloris attacks.
// 30s for headers (slowloris), 120s for full request, 120s keep-alive.
publicServer.headersTimeout = 30000;
publicServer.requestTimeout = 120000;
publicServer.keepAliveTimeout = 120000;
publicServer.maxHeadersCount = 50;

var adminServer = adminApp.listen(ADMIN_PORT, '127.0.0.1', function() {
  console.log('  Control Panel       http://localhost:' + ADMIN_PORT + '  (localhost-only, PIN-protected)\n');
  var url = 'http://localhost:' + PORT;
  var openCmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(openCmd[0], openCmd[1], { stdio: 'ignore', windowsHide: true }).unref();
});
adminServer.headersTimeout = 30000;
adminServer.requestTimeout = 120000;
adminServer.keepAliveTimeout = 120000;
adminServer.maxHeadersCount = 50;

// L2 fix: Graceful shutdown — drain connections, close DB, kill builds, remove PID
var { db } = require('./db');
function removePidFile() { try { fs.unlinkSync(PID_FILE); } catch (_) {} }

function gracefulShutdown(signal) {
  console.log('\n[shutdown] ' + signal + ' received — draining...');
  try { pipeline.killAll(); } catch (_) {}
  publicServer.close(function() {
    adminServer.close(function() {
      try { db.close(); } catch (_) {}
      removePidFile();
      console.log('[shutdown] Clean exit.');
      process.exit(0);
    });
  });
  // Force exit after 5s if drain takes too long
  setTimeout(function() {
    console.error('[shutdown] Forced exit after 5s timeout');
    try { db.close(); } catch (_) {}
    removePidFile();
    process.exit(1);
  }, 5000);
}

process.on('exit', removePidFile);
process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });
