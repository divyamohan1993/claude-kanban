const express = require('express');
const fs = require('fs');
const path = require('path');
const { cards, audit, auditLog, backups, db, errors: dbErrors } = require('../db');
const { broadcast, adminClients } = require('../lib/broadcast');
const { DATA_DIR, ROOT_DIR, IS_WIN, PORT, runtime } = require('../config');
const { requireAdmin } = require('../sso');
const { log } = require('../lib/logger');
const pipeline = require('../services/pipeline');
const support = require('../services/support');
const usageSvc = require('../services/usage');
const autoDiscover = require('../services/auto-discover');
const brainstormSvc = require('../services/brainstorm');
const intelligence = require('../services/intelligence');
const specIntelligence = require('../services/spec-intelligence');
const { rateLimiter } = require('../middleware/rate-limit');

const router = express.Router();
router.use(rateLimiter);

// --- Admin SSE (C2 fix: require auth) ---
router.get('/api/events', requireAdmin, function(req, res) {
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
  // Inject CSP nonce into the inline script tag
  let html = fs.readFileSync(path.join(ROOT_DIR, 'public', 'control-panel.html'), 'utf-8');
  const nonce = res.locals.cspNonce || '';
  html = html.replace('<script>', '<script nonce="' + nonce + '">');
  res.type('html').send(html);
});

// --- Read-only Board Data (C3 fix: require auth on all admin reads) ---
router.get('/api/cards', requireAdmin, function(_req, res) { res.json(cards.getAll()); });
router.get('/api/queue', requireAdmin, function(_req, res) { res.json(pipeline.getQueueInfo()); });
router.get('/api/activities', requireAdmin, function(_req, res) { res.json(pipeline.getActivities()); });
router.get('/api/metrics', requireAdmin, function(_req, res) { res.json(support.getMetrics()); });
router.get('/api/pipeline', requireAdmin, function(_req, res) { res.json({ paused: pipeline.isPaused() }); });
router.get('/api/export', requireAdmin, function(_req, res) { res.json(support.exportBoard({ full: true })); });
router.get('/api/audit', requireAdmin, function(_req, res) { res.json(audit.recent(500)); });
router.get('/api/audit/card/:id', requireAdmin, function(req, res) { res.json(audit.byResource('card', Number(req.params.id))); });
router.get('/api/archive', requireAdmin, function(_req, res) { res.json(cards.getArchived()); });

// --- Backups ---
router.get('/api/backups', requireAdmin, function(_req, res) {
  res.json({ backups: backups.list(), retentionDays: backups.getRetentionDays() });
});

router.post('/api/backups/create', requireAdmin, function(req, res) {
  const label = (req.body && req.body.label) || '';
  const result = backups.create(label);
  if (result.success) {
    auditLog('backup-create', 'backup', null, req.user.id, '', result.file, 'manual backup');
    broadcast('toast', { message: 'Manual backup created: ' + result.file, type: 'success' });
  }
  res.json(result);
});

router.post('/api/backups/restore', requireAdmin, function(req, res) {
  if (!req.body.backupPath) return res.status(400).json({ error: 'backupPath required' });
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Backup restore requires { "confirm": true }' });
  auditLog('backup-restore', 'backup', null, req.user.id, '', req.body.backupPath, 'restore initiated');
  res.json(backups.restore(req.body.backupPath));
});

// --- Usage ---
router.get('/api/usage', requireAdmin, function(_req, res) { res.json(usageSvc.getUsageStats()); });

router.post('/api/usage/refresh', requireAdmin, function(_req, res) {
  usageSvc.fetchClaudeUsage(true).then(function() {
    res.json(usageSvc.getUsageStats());
  });
});

// --- Config ---
router.get('/api/config', requireAdmin, function(_req, res) { res.json(usageSvc.getConfig(pipeline.getPipelineState(), { admin: true })); });

router.put('/api/config', requireAdmin, function(req, res) {
  const oldConfig = usageSvc.getConfig(pipeline.getPipelineState(), { admin: true }).runtime;
  const changed = usageSvc.setConfig(req.body);
  auditLog('config-change', 'config', null, req.user.id, oldConfig, changed, Object.keys(changed).join(', '));
  broadcast('toast', { message: 'Config updated: ' + Object.keys(changed).join(', '), type: 'success' });
  res.json({ changed: changed, config: usageSvc.getConfig(pipeline.getPipelineState(), { admin: true }) });
});

// --- Custom Prompts ---
router.get('/api/custom-prompts', requireAdmin, function(_req, res) { res.json(usageSvc.getCustomPrompts()); });

router.put('/api/custom-prompts', requireAdmin, function(req, res) {
  const MAX_PROMPT_LEN = 100000; // 100KB per field
  const fields = ['brainstormInstructions', 'buildInstructions', 'reviewCriteria', 'qualityGates'];
  for (let i = 0; i < fields.length; i++) {
    if (req.body[fields[i]] && String(req.body[fields[i]]).length > MAX_PROMPT_LEN) {
      return res.status(400).json({ error: fields[i] + ' exceeds maximum length (' + MAX_PROMPT_LEN + ' chars)' });
    }
  }
  const oldPrompts = usageSvc.getCustomPrompts();
  const data = usageSvc.setCustomPrompts(req.body);
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
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
  const created = [];
  const batch = items.slice(0, 50);
  for (let i = 0; i < batch.length; i++) {
    if (!batch[i].title) continue;
    const itemTitle = String(batch[i].title).slice(0, 500);
    const itemDesc = batch[i].description ? String(batch[i].description).slice(0, 10000) : '';
    const result = cards.create(itemTitle, itemDesc, batch[i].column || 'brainstorm');
    let card = cards.get(Number(result.lastInsertRowid));
    if (batch[i].labels) {
      cards.setLabels(card.id, batch[i].labels);
      card = cards.get(card.id);
    }
    broadcast('card-created', card);
    created.push(card);
  }
  res.json({ created: created.length, cards: created });
});

// --- Mode & Auto-Discovery ---
router.get('/api/mode', requireAdmin, function(_req, res) {
  res.json(autoDiscover.getState());
});

router.put('/api/mode', requireAdmin, function(req, res) {
  const { runtime } = require('../config');
  const changed = {};

  if (req.body.mode !== undefined) {
    const newMode = String(req.body.mode);
    if (newMode === 'global' || newMode === 'single-project') {
      const oldMode = runtime.mode;
      runtime.mode = newMode;
      changed.mode = newMode;
      auditLog('mode-change', 'config', null, req.user.id, oldMode, newMode, '');
      if (newMode === 'single-project') autoDiscover.init();
      else autoDiscover.stopPeriodicDiscovery();
    }
  }
  if (req.body.singleProjectPath !== undefined) {
    runtime.singleProjectPath = String(req.body.singleProjectPath);
    changed.singleProjectPath = runtime.singleProjectPath;
  }
  if (req.body.autoPromoteBrainstorm !== undefined) {
    runtime.autoPromoteBrainstorm = !!req.body.autoPromoteBrainstorm;
    changed.autoPromoteBrainstorm = runtime.autoPromoteBrainstorm;
  }
  if (req.body.maxBrainstormQueue !== undefined) {
    runtime.maxBrainstormQueue = Math.max(1, Math.min(10, Number(req.body.maxBrainstormQueue)));
    changed.maxBrainstormQueue = runtime.maxBrainstormQueue;
  }
  if (req.body.discoveryIntervalMins !== undefined) {
    runtime.discoveryIntervalMins = Math.max(0, Number(req.body.discoveryIntervalMins));
    changed.discoveryIntervalMins = runtime.discoveryIntervalMins;
    autoDiscover.startPeriodicDiscovery();
  }
  if (req.body.maxChildCards !== undefined) {
    runtime.maxChildCards = Math.max(1, Math.min(20, Number(req.body.maxChildCards)));
    changed.maxChildCards = runtime.maxChildCards;
  }

  broadcast('mode-updated', autoDiscover.getState());
  broadcast('toast', { message: 'Mode config updated: ' + Object.keys(changed).join(', '), type: 'success' });
  res.json({ changed: changed, state: autoDiscover.getState() });
});

router.post('/api/discovery/run', requireAdmin, function(_req, res) {
  autoDiscover.runDiscovery();
  res.json({ started: true });
});

router.get('/api/pending-actions', requireAdmin, function(_req, res) {
  res.json(autoDiscover.getPendingActions());
});

router.post('/api/pending-actions/:id/resolve', requireAdmin, function(req, res) {
  const resolved = autoDiscover.resolvePendingAction(Number(req.params.id));
  res.json({ resolved: resolved });
});

// --- Promote brainstorm to todo (manual approval mode) ---
router.post('/api/cards/:id/promote', requireAdmin, function(req, res) {
  brainstormSvc.promoteToTodo(Number(req.params.id)).then(function(result) {
    res.json({ success: true, result: result });
  }).catch(function(err) {
    res.status(400).json({ error: err.message });
  });
});

// --- Error Log API ---
router.get('/api/errors', requireAdmin, function(_req, res) {
  res.json({
    unresolved: dbErrors.unresolved(),
    unresolvedCount: dbErrors.count(),
  });
});

router.get('/api/errors/recent', requireAdmin, function(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json(dbErrors.recent(limit));
});

router.post('/api/errors/:id/resolve', requireAdmin, function(req, res) {
  const id = Number(req.params.id);
  dbErrors.resolve(id, null);
  auditLog('resolve-error', 'error', id, 'admin', '', 'resolved', 'manual resolution');
  res.json({ success: true });
});

// --- Intelligence / Learnings ---
router.get('/api/intelligence', requireAdmin, function(_req, res) {
  res.json(intelligence.getInsights());
});

router.post('/api/intelligence/analyze', requireAdmin, function(_req, res) {
  const changes = intelligence.analyzeAndTune();
  res.json({ changes: changes, insights: intelligence.getInsights() });
});

router.delete('/api/intelligence/learnings/:id', requireAdmin, function(req, res) {
  intelligence.removeLearning(Number(req.params.id));
  auditLog('delete-learning', 'learning', Number(req.params.id), req.user.id, '', '', 'manual removal');
  res.json({ success: true });
});

// --- Spec Intelligence ---
router.get('/api/spec-intelligence', requireAdmin, function(_req, res) {
  res.json(specIntelligence.getInsights());
});

// --- Checkpoints / Rollback ---
router.get('/api/checkpoints', requireAdmin, function(req, res) {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  res.json(intelligence.getCheckpoints(limit));
});

router.post('/api/checkpoints/:id/rollback', requireAdmin, function(req, res) {
  const result = intelligence.rollback(Number(req.params.id));
  if (result.success) {
    auditLog('rollback', 'checkpoint', Number(req.params.id), req.user.id, '', result.label, result.reverted.join('; '));
  }
  res.json(result);
});

// --- Factory Reset (nuke folder + fresh clone) ---
router.post('/api/factory-reset', requireAdmin, function(req, res) {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: 'Factory reset requires { "confirm": true }' });
  }

  var execFileSync = require('child_process').execFileSync;
  var cpSpawn = require('child_process').spawn;

  // Get git remote URL (execFileSync = no shell, safe from injection)
  var repoUrl;
  try {
    repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
  } catch (err) {
    return res.status(500).json({ error: 'Cannot determine git remote: ' + err.message });
  }
  // Validate repoUrl — must be a recognized git URL format (no shell metacharacters)
  if (!/^(https?:\/\/[^\s"'`;&|]+|git@[^\s"'`;&|]+:[^\s"'`;&|]+\.git|ssh:\/\/[^\s"'`;&|]+)$/.test(repoUrl)) {
    return res.status(500).json({ error: 'Git remote URL has unexpected format: ' + repoUrl });
  }

  auditLog('factory-reset', 'system', null, req.user.id, '', repoUrl, 'nuke + clone reset');
  try { pipeline.killAll(); } catch (_) {}

  var parentDir = path.resolve(ROOT_DIR, '..');
  var folderName = path.basename(ROOT_DIR);
  // Validate paths don't contain shell injection characters
  if (/[\0\r\n]/.test(parentDir) || /[\0\r\n]/.test(folderName)) {
    return res.status(500).json({ error: 'Root directory path contains unsafe characters' });
  }
  var envFile = path.join(ROOT_DIR, '.env');
  var envBackup = path.join(parentDir, '._kanban_env_backup');
  var resetLog = path.join(parentDir, '_kanban_reset.log');

  // Backup .env if it exists
  try { if (fs.existsSync(envFile)) fs.copyFileSync(envFile, envBackup); } catch (_) {}

  if (IS_WIN) {
    var batPath = path.join(parentDir, '_kanban_reset.bat');
    var batLines = [
      '@echo off',
      'setlocal enabledelayedexpansion',
      'set "LOGFILE=' + resetLog + '"',
      'echo [%date% %time%] Factory reset started >> "%LOGFILE%"',
      '',
      ':: Wait for server to exit (max 60s)',
      'set "waits=0"',
      ':waitloop',
      'timeout /t 2 /nobreak >nul 2>nul',
      'set /a waits+=1',
      'if !waits! gtr 30 goto waited',
      'tasklist /FI "PID eq ' + process.pid + '" 2>nul | findstr "' + process.pid + '" >nul 2>nul',
      'if %errorlevel% equ 0 goto waitloop',
      ':waited',
      'echo [%date% %time%] Server exited >> "%LOGFILE%"',
      'timeout /t 3 /nobreak >nul 2>nul',
      '',
      ':: Delete folder (retry up to 5x for file locks)',
      'cd /d "' + parentDir + '"',
      'set "retries=0"',
      ':delloop',
      'rd /s /q "' + ROOT_DIR + '" 2>nul',
      'if exist "' + ROOT_DIR + '" (',
      '  set /a retries+=1',
      '  if !retries! lss 5 (',
      '    echo [%date% %time%] Delete retry !retries!/5 >> "%LOGFILE%"',
      '    timeout /t 3 /nobreak >nul 2>nul',
      '    goto delloop',
      '  )',
      '  echo [%date% %time%] ERROR: Could not delete folder >> "%LOGFILE%"',
      '  goto :eof',
      ')',
      'echo [%date% %time%] Folder deleted >> "%LOGFILE%"',
      '',
      ':: Clone fresh',
      'git clone "' + repoUrl + '" "' + folderName + '" >> "%LOGFILE%" 2>&1',
      'if errorlevel 1 (',
      '  echo [%date% %time%] ERROR: git clone failed >> "%LOGFILE%"',
      '  goto :eof',
      ')',
      'echo [%date% %time%] Clone complete >> "%LOGFILE%"',
      '',
      ':: Restore .env',
      'if exist "' + envBackup + '" (',
      '  copy /y "' + envBackup + '" "' + path.join(ROOT_DIR, '.env') + '" >nul 2>nul',
      '  del /f "' + envBackup + '" >nul 2>nul',
      '  echo [%date% %time%] .env restored >> "%LOGFILE%"',
      ')',
      '',
      ':: Install dependencies',
      'cd /d "' + ROOT_DIR + '"',
      'call pnpm install >> "%LOGFILE%" 2>&1',
      'echo [%date% %time%] Dependencies installed >> "%LOGFILE%"',
      '',
      ':: Start server (hidden window)',
      'node -e "require(\'child_process\').spawn(process.execPath,[\'src/server.js\'],{detached:true,stdio:\'ignore\',windowsHide:true}).unref()"',
      'echo [%date% %time%] Server started >> "%LOGFILE%"',
    ];
    fs.writeFileSync(batPath, batLines.join('\r\n'));

    var child = cpSpawn('cmd', ['/c', batPath], {
      cwd: parentDir, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } else {
    var shPath = path.join(parentDir, '_kanban_reset.sh');
    var shLines = [
      '#!/bin/bash',
      'LOGFILE="' + resetLog + '"',
      'echo "$(date) Factory reset started" >> "$LOGFILE"',
      '',
      '# Wait for server to exit',
      'for i in $(seq 1 30); do kill -0 ' + process.pid + ' 2>/dev/null || break; sleep 2; done',
      'sleep 2',
      'echo "$(date) Server exited" >> "$LOGFILE"',
      '',
      '# Delete folder',
      'cd "' + parentDir + '"',
      'rm -rf "' + ROOT_DIR + '"',
      'echo "$(date) Folder deleted" >> "$LOGFILE"',
      '',
      '# Clone fresh',
      'git clone "' + repoUrl + '" "' + folderName + '" >> "$LOGFILE" 2>&1',
      'echo "$(date) Clone complete" >> "$LOGFILE"',
      '',
      '# Restore .env',
      '[ -f "' + envBackup + '" ] && cp "' + envBackup + '" "' + path.join(ROOT_DIR, '.env') + '" && rm -f "' + envBackup + '"',
      '',
      '# Install dependencies',
      'cd "' + ROOT_DIR + '"',
      'pnpm install >> "$LOGFILE" 2>&1',
      'echo "$(date) Dependencies installed" >> "$LOGFILE"',
      '',
      '# Start server',
      'nohup node src/server.js > /dev/null 2>&1 &',
      'echo "$(date) Server started (PID $!)" >> "$LOGFILE"',
      '',
      '# Self-cleanup',
      'rm -f "$0"',
    ];
    fs.writeFileSync(shPath, shLines.join('\n'), { mode: 0o755 });

    var child = cpSpawn('bash', [shPath], {
      cwd: parentDir, detached: true, stdio: 'ignore',
    });
    child.unref();
  }

  log.info({ repoUrl: repoUrl, parentDir: parentDir }, 'Factory reset — nuke script spawned');
  res.json({ success: true, port: PORT, note: 'Full reset in progress. Server will restart automatically.' });

  setTimeout(function() {
    process.kill(process.pid, 'SIGTERM');
  }, 500);
});

// --- Housekeeping ---
// Single-pass recursive scan: returns { size, files } in one traversal (was 2x before)
function dirStats(dir) {
  let size = 0, files = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].isDirectory()) {
        const sub = dirStats(path.join(dir, entries[i].name));
        size += sub.size;
        files += sub.files;
      } else {
        try { size += fs.statSync(path.join(dir, entries[i].name)).size; } catch (_) {}
        files++;
      }
    }
  } catch (_) {}
  return { size, files };
}

function getHousekeepingStats() {
  const dirs = {
    logs: path.join(DATA_DIR, 'logs'),
    snapshots: path.join(DATA_DIR, 'snapshots'),
    archive: path.join(DATA_DIR, 'archive'),
    runtime: path.join(DATA_DIR, 'runtime'),
    backups: path.join(DATA_DIR, 'backups'),
  };
  const result = {};
  let totalSize = 0;
  const keys = Object.keys(dirs);
  for (let i = 0; i < keys.length; i++) {
    const stats = dirStats(dirs[keys[i]]);
    result[keys[i]] = { path: dirs[keys[i]], size: stats.size, files: stats.files };
    totalSize += stats.size;
  }
  result.total = totalSize;
  return result;
}

function isPipelineIdle() {
  try {
    // O(1) via index instead of loading all cards
    return cards.countByColumn('working') === 0 &&
      cards.countByStatus('building') === 0 &&
      cards.countByStatus('brainstorming') === 0 &&
      cards.countByStatus('reviewing') === 0 &&
      cards.countByStatus('fixing') === 0;
  } catch (_) { return true; }
}

function runHousekeeping(force) {
  if (!force && !isPipelineIdle()) return { skipped: true, reason: 'pipeline active' };
  const now = Date.now();
  const cleaned = { logs: 0, markers: 0, runtime: 0, snapshotArchive: 0, audit: 0 };

  const logsDir = path.join(DATA_DIR, 'logs');
  const logCutoff = now - runtime.logRetentionDays * 86400000;
  try {
    const logFiles = fs.readdirSync(logsDir);
    for (let i = 0; i < logFiles.length; i++) {
      const fp = path.join(logsDir, logFiles[i]);
      try {
        if (fs.statSync(fp).mtimeMs < logCutoff) { fs.unlinkSync(fp); cleaned.logs++; }
      } catch (_) {}
    }
  } catch (_) {}

  try {
    const markerFiles = fs.readdirSync(logsDir);
    for (let j = 0; j < markerFiles.length; j++) {
      if (!markerFiles[j].endsWith('.scanned')) continue;
      const logFile = markerFiles[j].replace('.scanned', '');
      if (!fs.existsSync(path.join(logsDir, logFile))) {
        try { fs.unlinkSync(path.join(logsDir, markerFiles[j])); cleaned.markers++; } catch (_) {}
      }
    }
  } catch (_) {}

  const runtimeDir = path.join(DATA_DIR, 'runtime');
  const rtCutoff = now - runtime.runtimeStaleHours * 3600000;
  try {
    const rtFiles = fs.readdirSync(runtimeDir);
    for (let k = 0; k < rtFiles.length; k++) {
      const rfp = path.join(runtimeDir, rtFiles[k]);
      try {
        if (fs.statSync(rfp).mtimeMs < rtCutoff) { fs.unlinkSync(rfp); cleaned.runtime++; }
      } catch (_) {}
    }
  } catch (_) {}

  const archiveDir = path.join(DATA_DIR, 'archive', 'snapshots');
  const archCutoff = now - runtime.snapshotArchiveRetentionDays * 86400000;
  try {
    const archDirs = fs.readdirSync(archiveDir);
    for (let m = 0; m < archDirs.length; m++) {
      const dp = path.join(archiveDir, archDirs[m]);
      try {
        if (fs.statSync(dp).mtimeMs < archCutoff) {
          fs.rmSync(dp, { recursive: true, force: true });
          cleaned.snapshotArchive++;
        }
      } catch (_) {}
    }
  } catch (_) {}

  try {
    const total = audit.count();
    if (total > runtime.maxAuditRows) {
      const excess = total - runtime.maxAuditRows;
      db.prepare('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY timestamp ASC LIMIT ?)').run(excess);
      cleaned.audit = excess;
    }
  } catch (_) {}

  return cleaned;
}

router.get('/api/housekeeping', requireAdmin, function(_req, res) { res.json(getHousekeepingStats()); });

router.post('/api/housekeeping/run', requireAdmin, function(_req, res) {
  res.json(runHousekeeping(true));
});

// Export runHousekeeping for periodic use by server.js
router.runHousekeeping = runHousekeeping;

module.exports = router;
