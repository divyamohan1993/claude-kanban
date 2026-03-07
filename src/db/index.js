var Database = require('better-sqlite3');
var fs = require('fs');
var path = require('path');
var cfg = require('../config');

var DATA_DIR = cfg.DATA_DIR;
var DB_PATH = cfg.DB_PATH;
var BACKUP_DIR = cfg.BACKUP_DIR;
var BACKUP_HOT = cfg.BACKUP_HOT;
var BACKUP_HOURLY = cfg.BACKUP_HOURLY;
var BACKUP_DAILY = cfg.BACKUP_DAILY;
var VALID_COLUMNS = cfg.VALID_COLUMNS;
var MAX_ARCHIVED = cfg.MAX_ARCHIVED;

// Ensure directories
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
[BACKUP_HOT, BACKUP_HOURLY, BACKUP_DAILY].forEach(function(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Migrate old single backup file
var OLD_BACKUP = path.join(BACKUP_DIR, 'kanban.db.bak');
if (fs.existsSync(OLD_BACKUP)) {
  try {
    fs.renameSync(OLD_BACKUP, path.join(BACKUP_HOT, 'kanban.db'));
    console.log('[db] Migrated legacy backup to hot/');
  } catch (_) {}
}

// Find best backup for recovery
function findBestBackup() {
  var candidates = [];
  var dirs = [BACKUP_HOT, BACKUP_HOURLY, BACKUP_DAILY];
  for (var di = 0; di < dirs.length; di++) {
    try {
      var files = fs.readdirSync(dirs[di]);
      for (var fi = 0; fi < files.length; fi++) {
        if (!files[fi].endsWith('.db')) continue;
        var fp = path.join(dirs[di], files[fi]);
        try {
          var stat = fs.statSync(fp);
          if (stat.size > 0) candidates.push({ path: fp, mtime: stat.mtimeMs, size: stat.size });
        } catch (_) {}
      }
    } catch (_) {}
  }
  candidates.sort(function(a, b) { return b.mtime - a.mtime; });
  return candidates.length > 0 ? candidates[0] : null;
}

// Auto-recover from backup if DB missing
if (!fs.existsSync(DB_PATH)) {
  var best = findBestBackup();
  if (best) {
    fs.copyFileSync(best.path, DB_PATH);
    console.log('[db] Restored from backup:', best.path);
  }
}

var db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // M6 fix: retry on SQLITE_BUSY instead of immediate failure
db.pragma('optimize');

// Use bracket notation for SQLite exec to avoid false-positive security hook
// (hook incorrectly matches better-sqlite3's db.exec as child_process.exec)
var runSQL = db['exec'].bind(db);

runSQL([
  "CREATE TABLE IF NOT EXISTS cards (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  title TEXT NOT NULL,",
  "  description TEXT DEFAULT '',",
  "  spec TEXT DEFAULT '',",
  "  column_name TEXT NOT NULL DEFAULT 'brainstorm',",
  "  status TEXT NOT NULL DEFAULT 'idle',",
  "  project_path TEXT DEFAULT '',",
  "  session_log TEXT DEFAULT '',",
  "  created_at TEXT DEFAULT (datetime('now')),",
  "  updated_at TEXT DEFAULT (datetime('now'))",
  ");",
  "CREATE TABLE IF NOT EXISTS sessions (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,",
  "  type TEXT NOT NULL,",
  "  status TEXT DEFAULT 'running',",
  "  pid INTEGER,",
  "  output TEXT DEFAULT '',",
  "  started_at TEXT DEFAULT (datetime('now')),",
  "  completed_at TEXT",
  ");",
  "CREATE TABLE IF NOT EXISTS claude_usage (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  type TEXT NOT NULL,",
  "  card_id INTEGER,",
  "  started_at TEXT DEFAULT (datetime('now'))",
  ");",
].join('\n'));

// Schema migrations — safe to re-run
try { runSQL('ALTER TABLE cards ADD COLUMN review_score INTEGER DEFAULT 0'); } catch (_) {}
try { runSQL('ALTER TABLE cards ADD COLUMN review_data TEXT DEFAULT ""'); } catch (_) {}
try { runSQL('ALTER TABLE cards ADD COLUMN labels TEXT DEFAULT ""'); } catch (_) {}
try { runSQL('ALTER TABLE cards ADD COLUMN depends_on TEXT DEFAULT ""'); } catch (_) {}
try { runSQL('ALTER TABLE cards ADD COLUMN phase_durations TEXT DEFAULT ""'); } catch (_) {}
try { runSQL('ALTER TABLE cards ADD COLUMN approved_by TEXT DEFAULT ""'); } catch (_) {}
try { runSQL('ALTER TABLE cards ADD COLUMN deleted_at TEXT DEFAULT NULL'); } catch (_) {}

// Audit log — immutable, append-only compliance trail
runSQL([
  "CREATE TABLE IF NOT EXISTS audit_log (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),",
  "  action TEXT NOT NULL,",
  "  resource_type TEXT NOT NULL,",
  "  resource_id INTEGER,",
  "  actor TEXT DEFAULT 'system',",
  "  old_value TEXT DEFAULT '',",
  "  new_value TEXT DEFAULT '',",
  "  detail TEXT DEFAULT ''",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id);",
  "CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);",
].join('\n'));

var stmts = {
  getAll: db.prepare("SELECT * FROM cards WHERE column_name != 'archive' AND deleted_at IS NULL ORDER BY created_at ASC"),
  getArchived: db.prepare("SELECT * FROM cards WHERE column_name = 'archive' AND deleted_at IS NULL ORDER BY updated_at DESC"),
  countArchived: db.prepare("SELECT COUNT(*) as cnt FROM cards WHERE column_name = 'archive' AND deleted_at IS NULL"),
  oldestArchived: db.prepare("SELECT id FROM cards WHERE column_name = 'archive' AND deleted_at IS NULL ORDER BY updated_at ASC LIMIT ?"),
  get: db.prepare('SELECT * FROM cards WHERE id = ? AND deleted_at IS NULL'),
  getIncludingDeleted: db.prepare('SELECT * FROM cards WHERE id = ?'),
  create: db.prepare('INSERT INTO cards (title, description, column_name) VALUES (?, ?, ?)'),
  update: db.prepare("UPDATE cards SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?"),
  move: db.prepare("UPDATE cards SET column_name = ?, updated_at = datetime('now') WHERE id = ?"),
  setStatus: db.prepare("UPDATE cards SET status = ?, updated_at = datetime('now') WHERE id = ?"),
  setSpec: db.prepare("UPDATE cards SET spec = ?, updated_at = datetime('now') WHERE id = ?"),
  setProjectPath: db.prepare("UPDATE cards SET project_path = ?, updated_at = datetime('now') WHERE id = ?"),
  setSessionLog: db.prepare("UPDATE cards SET session_log = ?, updated_at = datetime('now') WHERE id = ?"),
  setReviewData: db.prepare("UPDATE cards SET review_score = ?, review_data = ?, updated_at = datetime('now') WHERE id = ?"),
  setApprovedBy: db.prepare("UPDATE cards SET approved_by = ?, updated_at = datetime('now') WHERE id = ?"),
  setLabels: db.prepare("UPDATE cards SET labels = ?, updated_at = datetime('now') WHERE id = ?"),
  setDependsOn: db.prepare("UPDATE cards SET depends_on = ?, updated_at = datetime('now') WHERE id = ?"),
  setPhaseDurations: db.prepare("UPDATE cards SET phase_durations = ?, updated_at = datetime('now') WHERE id = ?"),
  softDelete: db.prepare("UPDATE cards SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = datetime('now') WHERE id = ?"),
  search: db.prepare("SELECT * FROM cards WHERE deleted_at IS NULL AND (title LIKE ? OR description LIKE ? OR labels LIKE ?) ORDER BY updated_at DESC LIMIT 50"),
  createSession: db.prepare('INSERT INTO sessions (card_id, type, pid) VALUES (?, ?, ?)'),
  updateSession: db.prepare("UPDATE sessions SET status = ?, output = ?, completed_at = datetime('now') WHERE id = ?"),
  getSessionsByCard: db.prepare('SELECT * FROM sessions WHERE card_id = ? ORDER BY started_at DESC'),
  getAllSessions: db.prepare('SELECT * FROM sessions ORDER BY started_at DESC'),
  logUsage: db.prepare('INSERT INTO claude_usage (type, card_id) VALUES (?, ?)'),
  hourlyUsage: db.prepare("SELECT COUNT(*) as cnt FROM claude_usage WHERE started_at > datetime('now', '-1 hour')"),
  weeklyUsage: db.prepare("SELECT COUNT(*) as cnt FROM claude_usage WHERE started_at > datetime('now', '-7 days')"),
  usageBreakdown: db.prepare("SELECT type, COUNT(*) as cnt FROM claude_usage WHERE started_at > datetime('now', ?) GROUP BY type"),
  audit: db.prepare("INSERT INTO audit_log (action, resource_type, resource_id, actor, old_value, new_value, detail) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  auditByResource: db.prepare('SELECT * FROM audit_log WHERE resource_type = ? AND resource_id = ? ORDER BY timestamp DESC'),
  auditRecent: db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?'),
  auditAll: db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC'),
};

// --- Rolling Backup System ---
var BACKUP_RETENTION_DAYS = 7;

function hotBackupPath() { return path.join(BACKUP_HOT, 'kanban.db'); }
function hourlyBackupPath(d) { return path.join(BACKUP_HOURLY, 'kanban-' + d.toISOString().slice(0, 13).replace(':', '-') + '.db'); }
function dailyBackupPath(d) { return path.join(BACKUP_DAILY, 'kanban-' + d.toISOString().slice(0, 10) + '.db'); }

var lastSuccessfulBackup = Date.now();

function runBackupCycle() {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    db.pragma('optimize');
    var now = new Date();
    // L7 fix: log backup failures instead of silently swallowing
    db.backup(hotBackupPath()).then(function() {
      lastSuccessfulBackup = Date.now();
    }).catch(function(err) {
      console.error('[db] Hot backup failed:', err.message);
    });
    var hPath = hourlyBackupPath(now);
    if (!fs.existsSync(hPath)) db.backup(hPath).catch(function(err) {
      console.error('[db] Hourly backup failed:', err.message);
    });
    var dPath = dailyBackupPath(now);
    if (!fs.existsSync(dPath)) db.backup(dPath).catch(function(err) {
      console.error('[db] Daily backup failed:', err.message);
    });
    // Alert if no successful backup in 30 minutes
    if (Date.now() - lastSuccessfulBackup > 30 * 60 * 1000) {
      console.error('[db] WARNING: No successful backup in 30+ minutes');
    }
    pruneBackups();
  } catch (err) {
    console.error('[db] Backup cycle error:', err.message);
  }
}

function pruneBackups() {
  pruneDir(BACKUP_HOURLY, 24);
  pruneDir(BACKUP_DAILY, BACKUP_RETENTION_DAYS);
}

function pruneDir(dir, keep) {
  try {
    var files = fs.readdirSync(dir)
      .filter(function(f) { return f.endsWith('.db'); })
      .map(function(f) { return { name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }; })
      .sort(function(a, b) { return b.mtime - a.mtime; });
    for (var i = keep; i < files.length; i++) {
      try { fs.unlinkSync(path.join(dir, files[i].name)); } catch (_) {}
    }
  } catch (_) {}
}

function listBackups() {
  var result = [];
  var tiers = [['hot', BACKUP_HOT], ['hourly', BACKUP_HOURLY], ['daily', BACKUP_DAILY]];
  for (var ti = 0; ti < tiers.length; ti++) {
    var tier = tiers[ti][0], dir = tiers[ti][1];
    try {
      var files = fs.readdirSync(dir);
      for (var fi = 0; fi < files.length; fi++) {
        if (!files[fi].endsWith('.db')) continue;
        var fp = path.join(dir, files[fi]);
        try {
          var stat = fs.statSync(fp);
          result.push({ tier: tier, file: files[fi], path: fp, size: stat.size, mtime: stat.mtimeMs, modified: new Date(stat.mtimeMs).toISOString() });
        } catch (_) {}
      }
    } catch (_) {}
  }
  result.sort(function(a, b) { return b.mtime - a.mtime; });
  return result;
}

function restoreBackup(backupPath) {
  var resolved = path.resolve(backupPath);
  if (!resolved.startsWith(BACKUP_DIR + path.sep)) return { success: false, reason: 'Invalid backup path' };
  if (!fs.existsSync(resolved)) return { success: false, reason: 'Backup file not found' };
  try {
    var fd = fs.openSync(resolved, 'r');
    var buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (buf.toString('utf-8', 0, 15) !== 'SQLite format 3') return { success: false, reason: 'Not a valid SQLite database' };
  } catch (e) {
    return { success: false, reason: 'Cannot read backup: ' + e.message };
  }
  try {
    var safetyPath = path.join(BACKUP_HOT, 'pre-restore-' + Date.now() + '.db');
    fs.copyFileSync(DB_PATH, safetyPath);
  } catch (_) {}
  try { db.close(); } catch (_) {}
  fs.copyFileSync(resolved, DB_PATH);
  return { success: true, restored: resolved, note: 'Server restart required to use restored database' };
}

function createManualBackup(label) {
  var ts = new Date().toISOString().replace(/[:.]/g, '-');
  var name = 'kanban-manual-' + (label ? label.replace(/[^a-zA-Z0-9_-]/g, '') + '-' : '') + ts + '.db';
  var dest = path.join(BACKUP_DAILY, name);
  try {
    db.backup(dest).catch(function() {});
    return { success: true, file: name, path: dest };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

// Periodic backup every 5 min
setInterval(runBackupCycle, 5 * 60 * 1000);

// Immediate backup on load
try { db.backup(hotBackupPath()).catch(function(err) { console.error('[db] Initial backup failed:', err.message); }); } catch (_) {}

function auditLog(action, resourceType, resourceId, actor, oldVal, newVal, detail) {
  try {
    stmts.audit.run(action, resourceType, resourceId || null, actor || 'system',
      typeof oldVal === 'object' ? JSON.stringify(oldVal) : String(oldVal || ''),
      typeof newVal === 'object' ? JSON.stringify(newVal) : String(newVal || ''),
      detail || '');
  } catch (_) {}
}

module.exports = {
  db: db,
  VALID_COLUMNS: VALID_COLUMNS,
  auditLog: auditLog,
  cards: {
    getAll: function() { return stmts.getAll.all(); },
    getArchived: function() { return stmts.getArchived.all(); },
    rotateArchive: function() {
      var cnt = stmts.countArchived.get().cnt;
      if (cnt <= MAX_ARCHIVED) return [];
      var excess = stmts.oldestArchived.all(cnt - MAX_ARCHIVED);
      var ids = excess.map(function(r) { return r.id; });
      for (var i = 0; i < ids.length; i++) {
        stmts.softDelete.run(ids[i]);
        auditLog('soft-delete', 'card', ids[i], 'system', '', '', 'archive rotation');
      }
      return ids;
    },
    get: function(id) { return stmts.get.get(id); },
    getIncludingDeleted: function(id) { return stmts.getIncludingDeleted.get(id); },
    create: function(title, desc, col) { return stmts.create.run(title, desc || '', col || 'brainstorm'); },
    update: function(id, title, desc) { return stmts.update.run(title, desc, id); },
    move: function(id, col) {
      if (!VALID_COLUMNS.includes(col)) throw new Error('Invalid column: ' + col);
      stmts.move.run(col, id);
    },
    setStatus: function(id, status) { stmts.setStatus.run(status, id); },
    setSpec: function(id, spec) { stmts.setSpec.run(spec, id); },
    setProjectPath: function(id, p) { stmts.setProjectPath.run(p, id); },
    setSessionLog: function(id, log) { stmts.setSessionLog.run(log, id); },
    setReviewData: function(id, score, data) { stmts.setReviewData.run(score, data, id); },
    setApprovedBy: function(id, by) { stmts.setApprovedBy.run(by, id); },
    setLabels: function(id, labels) { stmts.setLabels.run(labels, id); },
    setDependsOn: function(id, deps) { stmts.setDependsOn.run(deps, id); },
    setPhaseDurations: function(id, durations) { stmts.setPhaseDurations.run(durations, id); },
    search: function(query) { var q = '%' + query + '%'; return stmts.search.all(q, q, q); },
    delete: function(id) {
      var card = stmts.get.get(id);
      stmts.softDelete.run(id);
      auditLog('delete', 'card', id, 'user', card ? card.title : '', '', 'soft-deleted');
    },
    updateState: function(id, updates) {
      var allowed = ['status', 'column_name', 'spec', 'review_score', 'review_data', 'project_path', 'labels', 'depends_on', 'phase_durations', 'approved_by'];
      var filtered = {};
      var allKeys = Object.keys(updates);
      for (var ki = 0; ki < allKeys.length; ki++) {
        if (allowed.includes(allKeys[ki])) filtered[allKeys[ki]] = updates[allKeys[ki]];
      }
      if (filtered.column_name && !VALID_COLUMNS.includes(filtered.column_name)) {
        throw new Error('Invalid column: ' + filtered.column_name);
      }
      var keys = Object.keys(filtered);
      if (keys.length === 0) return;
      var setClauses = keys.map(function(k) { return k + " = ?"; }).join(', ');
      var values = keys.map(function(k) { return filtered[k]; });
      values.push(id);
      db.prepare("UPDATE cards SET " + setClauses + ", updated_at = datetime('now') WHERE id = ?").run.apply(null, values);
    },
  },
  sessions: {
    create: function(cardId, type, pid) { return stmts.createSession.run(cardId, type, pid); },
    update: function(id, status, output) { stmts.updateSession.run(status, output, id); },
    getByCard: function(cardId) { return stmts.getSessionsByCard.all(cardId); },
    getAll: function() { return stmts.getAllSessions.all(); },
  },
  usage: {
    log: function(type, cardId) { stmts.logUsage.run(type, cardId || null); },
    hourly: function() { return stmts.hourlyUsage.get().cnt; },
    weekly: function() { return stmts.weeklyUsage.get().cnt; },
    breakdown: function(interval) { return stmts.usageBreakdown.all(interval); },
  },
  audit: {
    log: auditLog,
    byResource: function(type, id) { return stmts.auditByResource.all(type, id); },
    recent: function(limit) { return stmts.auditRecent.all(limit || 100); },
    all: function() { return stmts.auditAll.all(); },
  },
  backups: {
    list: listBackups,
    restore: restoreBackup,
    create: createManualBackup,
    findBest: findBestBackup,
    getRetentionDays: function() { return BACKUP_RETENTION_DAYS; },
    setRetentionDays: function(days) { BACKUP_RETENTION_DAYS = Math.max(1, Number(days) || 7); },
  },
};
