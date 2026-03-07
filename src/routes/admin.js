var express = require('express');
var fs = require('fs');
var path = require('path');
var { cards, audit, auditLog, backups, db } = require('../db');
var { broadcast, adminClients } = require('../lib/broadcast');
var { DATA_DIR, ADMIN_PIN, LOG_RETENTION_DAYS, SNAPSHOT_ARCHIVE_RETENTION_DAYS, MAX_AUDIT_ROWS, RUNTIME_STALE_HOURS, ROOT_DIR } = require('../config');
var { requireAdmin } = require('../lib/session');
var { PinAuthProvider, createSessionHandler, createLoginHandler, logoutHandler } = require('../middleware/auth');
var pipeline = require('../services/pipeline');
var support = require('../services/support');
var usageSvc = require('../services/usage');
var snapshot = require('../services/snapshot');

var router = express.Router();

// --- Auth Provider ---
var authProvider = new PinAuthProvider(ADMIN_PIN);

// --- Auth Routes (session-based, HTTP-only cookies) ---
router.get('/api/auth/session', createSessionHandler(authProvider));
router.post('/api/auth/login', createLoginHandler(authProvider));
router.post('/api/auth/logout', logoutHandler);

// --- Admin SSE ---
router.get('/api/events', function(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: connected\n\n');
  adminClients.add(res);
  req.on('close', function() { adminClients.delete(res); });
});

// --- Control Panel ---
router.get('/', function(_req, res) {
  res.sendFile(path.join(ROOT_DIR, 'public', 'control-panel.html'));
});

// --- Read-only Board Data ---
router.get('/api/cards', function(_req, res) { res.json(cards.getAll()); });
router.get('/api/queue', function(_req, res) { res.json(pipeline.getQueueInfo()); });
router.get('/api/activities', function(_req, res) { res.json(pipeline.getActivities()); });
router.get('/api/metrics', function(_req, res) { res.json(support.getMetrics()); });
router.get('/api/pipeline', function(_req, res) { res.json({ paused: pipeline.isPaused() }); });
router.get('/api/export', function(_req, res) { res.json(support.exportBoard()); });
router.get('/api/audit', function(_req, res) { res.json(audit.recent(500)); });
router.get('/api/audit/card/:id', function(req, res) { res.json(audit.byResource('card', Number(req.params.id))); });
router.get('/api/archive', function(_req, res) { res.json(cards.getArchived()); });

// --- Backups ---
router.get('/api/backups', function(_req, res) {
  res.json({ backups: backups.list(), retentionDays: backups.getRetentionDays() });
});

router.post('/api/backups/create', requireAdmin, function(req, res) {
  var label = (req.body && req.body.label) || '';
  var result = backups.create(label);
  if (result.success) {
    auditLog('backup-create', 'backup', null, req.user.id, '', result.file, 'manual backup');
    broadcast('toast', { message: 'Manual backup created: ' + result.file, type: 'success' });
  }
  res.json(result);
});

router.post('/api/backups/restore', requireAdmin, function(req, res) {
  if (!req.body.backupPath) return res.status(400).json({ error: 'backupPath required' });
  auditLog('backup-restore', 'backup', null, req.user.id, '', req.body.backupPath, 'restore initiated');
  res.json(backups.restore(req.body.backupPath));
});

// --- Usage ---
router.get('/api/usage', function(_req, res) { res.json(usageSvc.getUsageStats()); });

router.post('/api/usage/refresh', requireAdmin, function(_req, res) {
  usageSvc.fetchClaudeUsage(true).then(function() {
    res.json(usageSvc.getUsageStats());
  });
});

// --- Config ---
router.get('/api/config', function(_req, res) { res.json(usageSvc.getConfig(pipeline.getPipelineState())); });

router.put('/api/config', requireAdmin, function(req, res) {
  var oldConfig = usageSvc.getConfig(pipeline.getPipelineState()).runtime;
  var changed = usageSvc.setConfig(req.body);
  auditLog('config-change', 'config', null, req.user.id, oldConfig, changed, Object.keys(changed).join(', '));
  broadcast('toast', { message: 'Config updated: ' + Object.keys(changed).join(', '), type: 'success' });
  res.json({ changed: changed, config: usageSvc.getConfig(pipeline.getPipelineState()) });
});

// --- Custom Prompts ---
router.get('/api/custom-prompts', function(_req, res) { res.json(usageSvc.getCustomPrompts()); });

router.put('/api/custom-prompts', requireAdmin, function(req, res) {
  var oldPrompts = usageSvc.getCustomPrompts();
  var data = usageSvc.setCustomPrompts(req.body);
  auditLog('prompts-change', 'config', null, req.user.id, oldPrompts, data, 'custom prompts updated');
  broadcast('toast', { message: 'Custom prompts updated', type: 'success' });
  res.json(data);
});

// --- Pipeline Control ---
router.post('/api/pipeline/pause', requireAdmin, function(_req, res) {
  pipeline.setPaused(true);
  res.json({ paused: true });
});

router.post('/api/pipeline/resume', requireAdmin, function(_req, res) {
  pipeline.setPaused(false);
  res.json({ paused: false });
});

router.post('/api/pipeline/kill-all', requireAdmin, function(_req, res) {
  res.json({ killed: pipeline.killAll() });
});

router.post('/api/cards/:id/stop', requireAdmin, function(req, res) {
  try { res.json(pipeline.stopCard(Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Bulk Import (protected) ---
router.post('/api/bulk-create', requireAdmin, function(req, res) {
  var items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
  var created = [];
  var batch = items.slice(0, 50);
  for (var i = 0; i < batch.length; i++) {
    if (!batch[i].title) continue;
    var result = cards.create(batch[i].title, batch[i].description || '', batch[i].column || 'brainstorm');
    var card = cards.get(Number(result.lastInsertRowid));
    if (batch[i].labels) cards.setLabels(card.id, batch[i].labels);
    broadcast('card-created', cards.get(card.id));
    created.push(cards.get(card.id));
  }
  res.json({ created: created.length, cards: created });
});

// --- Factory Reset ---
router.post('/api/factory-reset', requireAdmin, function(_req, res) {
  auditLog('factory-reset', 'system', null, 'admin', '', '', 'full factory reset initiated');
  try { pipeline.killAll(); } catch (_) {}
  res.json({ success: true, note: 'Server will shut down. Restart to get a fresh instance.' });
  setTimeout(function() {
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
    console.log('[factory-reset] All data wiped. Exiting.');
    // L6 fix: use SIGTERM for graceful shutdown instead of process.exit(0)
    process.kill(process.pid, 'SIGTERM');
  }, 500);
});

// --- Housekeeping ---
function dirSize(dir) {
  var total = 0;
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) total += dirSize(fp);
      else try { total += fs.statSync(fp).size; } catch (_) {}
    }
  } catch (_) {}
  return total;
}

function countFiles(dir) {
  try {
    var count = 0;
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isDirectory()) count += countFiles(path.join(dir, entries[i].name));
      else count++;
    }
    return count;
  } catch (_) { return 0; }
}

function getHousekeepingStats() {
  var logsDir = path.join(DATA_DIR, 'logs');
  var snapshotsDir = path.join(DATA_DIR, 'snapshots');
  var archiveDir = path.join(DATA_DIR, 'archive');
  var runtimeDir = path.join(DATA_DIR, 'runtime');
  var backupsDir = path.join(DATA_DIR, 'backups');
  return {
    logs: { path: logsDir, size: dirSize(logsDir), files: countFiles(logsDir) },
    snapshots: { path: snapshotsDir, size: dirSize(snapshotsDir), files: countFiles(snapshotsDir) },
    archive: { path: archiveDir, size: dirSize(archiveDir), files: countFiles(archiveDir) },
    runtime: { path: runtimeDir, size: dirSize(runtimeDir), files: countFiles(runtimeDir) },
    backups: { path: backupsDir, size: dirSize(backupsDir), files: countFiles(backupsDir) },
    total: dirSize(DATA_DIR),
  };
}

function isPipelineIdle() {
  try {
    var all = cards.getAll();
    return !all.some(function(c) {
      return c.column_name === 'working' ||
        ['building', 'brainstorming', 'reviewing', 'fixing'].includes(c.status);
    });
  } catch (_) { return true; }
}

function runHousekeeping(force) {
  if (!force && !isPipelineIdle()) return { skipped: true, reason: 'pipeline active' };
  var now = Date.now();
  var cleaned = { logs: 0, markers: 0, runtime: 0, snapshotArchive: 0, audit: 0 };

  var logsDir = path.join(DATA_DIR, 'logs');
  var logCutoff = now - LOG_RETENTION_DAYS * 86400000;
  try {
    var logFiles = fs.readdirSync(logsDir);
    for (var i = 0; i < logFiles.length; i++) {
      var fp = path.join(logsDir, logFiles[i]);
      try {
        if (fs.statSync(fp).mtimeMs < logCutoff) { fs.unlinkSync(fp); cleaned.logs++; }
      } catch (_) {}
    }
  } catch (_) {}

  try {
    var markerFiles = fs.readdirSync(logsDir);
    for (var j = 0; j < markerFiles.length; j++) {
      if (!markerFiles[j].endsWith('.scanned')) continue;
      var logFile = markerFiles[j].replace('.scanned', '');
      if (!fs.existsSync(path.join(logsDir, logFile))) {
        try { fs.unlinkSync(path.join(logsDir, markerFiles[j])); cleaned.markers++; } catch (_) {}
      }
    }
  } catch (_) {}

  var runtimeDir = path.join(DATA_DIR, 'runtime');
  var rtCutoff = now - RUNTIME_STALE_HOURS * 3600000;
  try {
    var rtFiles = fs.readdirSync(runtimeDir);
    for (var k = 0; k < rtFiles.length; k++) {
      var rfp = path.join(runtimeDir, rtFiles[k]);
      try {
        if (fs.statSync(rfp).mtimeMs < rtCutoff) { fs.unlinkSync(rfp); cleaned.runtime++; }
      } catch (_) {}
    }
  } catch (_) {}

  var archiveDir = path.join(DATA_DIR, 'archive', 'snapshots');
  var archCutoff = now - SNAPSHOT_ARCHIVE_RETENTION_DAYS * 86400000;
  try {
    var archDirs = fs.readdirSync(archiveDir);
    for (var m = 0; m < archDirs.length; m++) {
      var dp = path.join(archiveDir, archDirs[m]);
      try {
        if (fs.statSync(dp).mtimeMs < archCutoff) {
          fs.rmSync(dp, { recursive: true, force: true });
          cleaned.snapshotArchive++;
        }
      } catch (_) {}
    }
  } catch (_) {}

  try {
    var total = audit.all().length;
    if (total > MAX_AUDIT_ROWS) {
      var excess = total - MAX_AUDIT_ROWS;
      db.prepare('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY timestamp ASC LIMIT ?)').run(excess);
      cleaned.audit = excess;
    }
  } catch (_) {}

  return cleaned;
}

router.get('/api/housekeeping', function(_req, res) { res.json(getHousekeepingStats()); });

router.post('/api/housekeeping/run', requireAdmin, function(_req, res) {
  res.json(runHousekeeping(true));
});

// Export runHousekeeping for periodic use by server.js
router.runHousekeeping = runHousekeeping;

module.exports = router;
