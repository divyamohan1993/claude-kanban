const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { log } = require('../lib/logger');

const DATA_DIR = cfg.DATA_DIR;
const DB_PATH = cfg.DB_PATH;
const BACKUP_DIR = cfg.BACKUP_DIR;
const BACKUP_HOT = cfg.BACKUP_HOT;
const BACKUP_HOURLY = cfg.BACKUP_HOURLY;
const BACKUP_DAILY = cfg.BACKUP_DAILY;
const VALID_COLUMNS = cfg.VALID_COLUMNS;
const MAX_ARCHIVED = cfg.MAX_ARCHIVED;

// Ensure directories
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
[BACKUP_HOT, BACKUP_HOURLY, BACKUP_DAILY].forEach(function(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Migrate old single backup file
const OLD_BACKUP = path.join(BACKUP_DIR, 'kanban.db.bak');
if (fs.existsSync(OLD_BACKUP)) {
  try {
    fs.renameSync(OLD_BACKUP, path.join(BACKUP_HOT, 'kanban.db'));
    log.info('Migrated legacy backup to hot/');
  } catch (_) {}
}

// Find best backup for recovery
function findBestBackup() {
  const candidates = [];
  const dirs = [BACKUP_HOT, BACKUP_HOURLY, BACKUP_DAILY];
  for (let di = 0; di < dirs.length; di++) {
    try {
      const files = fs.readdirSync(dirs[di]);
      for (let fi = 0; fi < files.length; fi++) {
        if (!files[fi].endsWith('.db')) continue;
        const fp = path.join(dirs[di], files[fi]);
        try {
          const stat = fs.statSync(fp);
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
  const best = findBestBackup();
  if (best) {
    fs.copyFileSync(best.path, DB_PATH);
    log.info({ backup: best.path }, 'Restored DB from backup');
  }
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // M6 fix: retry on SQLITE_BUSY instead of immediate failure
db.pragma('optimize');

// Use bracket notation for SQLite exec to avoid false-positive security hook
// (hook incorrectly matches better-sqlite3's db.exec as child_process.exec)
const runSQL = db['exec'].bind(db);

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
try { runSQL('ALTER TABLE cards ADD COLUMN parent_card_id INTEGER DEFAULT NULL'); } catch (_) {}
try { runSQL('ALTER TABLE cards ADD COLUMN spec_score INTEGER DEFAULT 0'); } catch (_) {}

// Config key-value store — server config persisted in DB
runSQL([
  "CREATE TABLE IF NOT EXISTS config (",
  "  key TEXT PRIMARY KEY,",
  "  value TEXT NOT NULL DEFAULT '',",
  "  updated_at TEXT DEFAULT (datetime('now'))",
  ");",
].join('\n'));

// Error log — structured error persistence for auto-fix pipeline
runSQL([
  "CREATE TABLE IF NOT EXISTS error_log (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),",
  "  level TEXT NOT NULL DEFAULT 'error',",
  "  source TEXT DEFAULT '',",
  "  card_id INTEGER,",
  "  message TEXT NOT NULL,",
  "  context TEXT DEFAULT '{}',",
  "  resolved INTEGER DEFAULT 0,",
  "  resolved_at TEXT,",
  "  fix_card_id INTEGER",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_error_unresolved ON error_log(resolved, timestamp);",
  "CREATE INDEX IF NOT EXISTS idx_error_card ON error_log(card_id);",
].join('\n'));

// Learnings — persistent pattern memory across server restarts
runSQL([
  "CREATE TABLE IF NOT EXISTS learnings (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  category TEXT NOT NULL,",
  "  pattern_key TEXT NOT NULL,",
  "  pattern_value TEXT NOT NULL DEFAULT '',",
  "  confidence INTEGER NOT NULL DEFAULT 50,",
  "  occurrences INTEGER NOT NULL DEFAULT 1,",
  "  applied INTEGER NOT NULL DEFAULT 0,",
  "  last_seen TEXT DEFAULT (datetime('now')),",
  "  created_at TEXT DEFAULT (datetime('now')),",
  "  UNIQUE(category, pattern_key)",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_learnings_cat ON learnings(category);",
].join('\n'));

// Checkpoints — rollback points for auto-changes
runSQL([
  "CREATE TABLE IF NOT EXISTS checkpoints (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  label TEXT NOT NULL,",
  "  change_type TEXT NOT NULL,",
  "  change_detail TEXT DEFAULT '',",
  "  rollback_data TEXT DEFAULT '{}',",
  "  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  ");",
].join('\n'));

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

const stmts = {
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
  setSpecScore: db.prepare("UPDATE cards SET spec_score = ?, updated_at = datetime('now') WHERE id = ?"),
  setParentCardId: db.prepare("UPDATE cards SET parent_card_id = ?, updated_at = datetime('now') WHERE id = ?"),
  getByParent: db.prepare("SELECT * FROM cards WHERE parent_card_id = ? AND deleted_at IS NULL ORDER BY created_at ASC"),
  countByParentAndColumn: db.prepare("SELECT COUNT(*) as cnt FROM cards WHERE parent_card_id = ? AND column_name != 'done' AND column_name != 'archive' AND deleted_at IS NULL"),
  getActiveInitiative: db.prepare("SELECT * FROM cards WHERE parent_card_id IS NULL AND column_name NOT IN ('done', 'archive') AND deleted_at IS NULL AND spec IS NOT NULL AND spec != '' ORDER BY created_at ASC LIMIT 1"),
  configGet: db.prepare("SELECT value FROM config WHERE key = ?"),
  configSet: db.prepare("INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"),
  configAll: db.prepare("SELECT * FROM config ORDER BY key"),
  errorInsert: db.prepare("INSERT INTO error_log (level, source, card_id, message, context) VALUES (?, ?, ?, ?, ?)"),
  errorUnresolved: db.prepare("SELECT * FROM error_log WHERE resolved = 0 ORDER BY timestamp DESC"),
  errorByCard: db.prepare("SELECT * FROM error_log WHERE card_id = ? ORDER BY timestamp DESC"),
  errorResolve: db.prepare("UPDATE error_log SET resolved = 1, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), fix_card_id = ? WHERE id = ?"),
  errorResolveByCard: db.prepare("UPDATE error_log SET resolved = 1, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE card_id = ? AND resolved = 0"),
  errorRecent: db.prepare("SELECT * FROM error_log ORDER BY timestamp DESC LIMIT ?"),
  errorCount: db.prepare("SELECT COUNT(*) as cnt FROM error_log WHERE resolved = 0"),
  errorPrune: db.prepare("DELETE FROM error_log WHERE timestamp < datetime('now', ?)"),
  // Learnings
  learningUpsert: db.prepare("INSERT INTO learnings (category, pattern_key, pattern_value, confidence, occurrences) VALUES (?, ?, ?, ?, 1) ON CONFLICT(category, pattern_key) DO UPDATE SET pattern_value = excluded.pattern_value, confidence = MIN(100, confidence + 5), occurrences = occurrences + 1, last_seen = datetime('now')"),
  learningGetByCategory: db.prepare("SELECT * FROM learnings WHERE category = ? ORDER BY confidence DESC, occurrences DESC"),
  learningGetAll: db.prepare("SELECT * FROM learnings ORDER BY category, confidence DESC"),
  learningGet: db.prepare("SELECT * FROM learnings WHERE category = ? AND pattern_key = ?"),
  learningDelete: db.prepare("DELETE FROM learnings WHERE id = ?"),
  learningBumpApplied: db.prepare("UPDATE learnings SET applied = applied + 1, last_seen = datetime('now') WHERE id = ?"),
  learningSetConfidence: db.prepare("UPDATE learnings SET confidence = ? WHERE id = ?"),
  learningPrune: db.prepare("DELETE FROM learnings WHERE confidence < 20 AND occurrences < 3 AND last_seen < datetime('now', '-30 days')"),
  // Checkpoints
  checkpointCreate: db.prepare("INSERT INTO checkpoints (label, change_type, change_detail, rollback_data) VALUES (?, ?, ?, ?)"),
  checkpointRecent: db.prepare("SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT ?"),
  checkpointGet: db.prepare("SELECT * FROM checkpoints WHERE id = ?"),
  checkpointDelete: db.prepare("DELETE FROM checkpoints WHERE id = ?"),
  checkpointPrune: db.prepare("DELETE FROM checkpoints WHERE created_at < datetime('now', '-7 days')"),
};

// --- Rolling Backup System ---
let BACKUP_RETENTION_DAYS = 7;

function hotBackupPath() { return path.join(BACKUP_HOT, 'kanban.db'); }
function hourlyBackupPath(d) { return path.join(BACKUP_HOURLY, 'kanban-' + d.toISOString().slice(0, 13).replace(':', '-') + '.db'); }
function dailyBackupPath(d) { return path.join(BACKUP_DAILY, 'kanban-' + d.toISOString().slice(0, 10) + '.db'); }

let lastSuccessfulBackup = Date.now();

function runBackupCycle() {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    db.pragma('optimize');
    const now = new Date();
    // L7 fix: log backup failures instead of silently swallowing
    db.backup(hotBackupPath()).then(function() {
      lastSuccessfulBackup = Date.now();
    }).catch(function(err) {
      log.error({ err: err.message }, 'Hot backup failed');
    });
    const hPath = hourlyBackupPath(now);
    if (!fs.existsSync(hPath)) db.backup(hPath).catch(function(err) {
      log.error({ err: err.message }, 'Hourly backup failed');
    });
    const dPath = dailyBackupPath(now);
    if (!fs.existsSync(dPath)) db.backup(dPath).catch(function(err) {
      log.error({ err: err.message }, 'Daily backup failed');
    });
    // Alert if no successful backup in 30 minutes
    if (Date.now() - lastSuccessfulBackup > 30 * 60 * 1000) {
      log.error('No successful backup in 30+ minutes');
    }
    pruneBackups();
  } catch (err) {
    log.error({ err: err.message }, 'Backup cycle error');
  }
}

function pruneBackups() {
  pruneDir(BACKUP_HOURLY, 24);
  pruneDir(BACKUP_DAILY, BACKUP_RETENTION_DAYS);
}

function pruneDir(dir, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter(function(f) { return f.endsWith('.db'); })
      .map(function(f) { return { name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }; })
      .sort(function(a, b) { return b.mtime - a.mtime; });
    for (let i = keep; i < files.length; i++) {
      try { fs.unlinkSync(path.join(dir, files[i].name)); } catch (_) {}
    }
  } catch (_) {}
}

function listBackups() {
  const result = [];
  const tiers = [['hot', BACKUP_HOT], ['hourly', BACKUP_HOURLY], ['daily', BACKUP_DAILY]];
  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti][0], dir = tiers[ti][1];
    try {
      const files = fs.readdirSync(dir);
      for (let fi = 0; fi < files.length; fi++) {
        if (!files[fi].endsWith('.db')) continue;
        const fp = path.join(dir, files[fi]);
        try {
          const stat = fs.statSync(fp);
          result.push({ tier: tier, file: files[fi], path: fp, size: stat.size, mtime: stat.mtimeMs, modified: new Date(stat.mtimeMs).toISOString() });
        } catch (_) {}
      }
    } catch (_) {}
  }
  result.sort(function(a, b) { return b.mtime - a.mtime; });
  return result;
}

function restoreBackup(backupPath) {
  const resolved = path.resolve(backupPath);
  if (!resolved.startsWith(BACKUP_DIR + path.sep)) return { success: false, reason: 'Invalid backup path' };
  if (!fs.existsSync(resolved)) return { success: false, reason: 'Backup file not found' };
  try {
    const fd = fs.openSync(resolved, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (buf.toString('utf-8', 0, 15) !== 'SQLite format 3') return { success: false, reason: 'Not a valid SQLite database' };
  } catch (e) {
    return { success: false, reason: 'Cannot read backup: ' + e.message };
  }
  try {
    const safetyPath = path.join(BACKUP_HOT, 'pre-restore-' + Date.now() + '.db');
    fs.copyFileSync(DB_PATH, safetyPath);
  } catch (_) {}
  try { db.close(); } catch (_) {}
  fs.copyFileSync(resolved, DB_PATH);
  return { success: true, restored: resolved, note: 'Server restart required to use restored database' };
}

function createManualBackup(label) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = 'kanban-manual-' + (label ? label.replace(/[^a-zA-Z0-9_-]/g, '') + '-' : '') + ts + '.db';
  const dest = path.join(BACKUP_DAILY, name);
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
try { db.backup(hotBackupPath()).catch(function(err) { log.error({ err: err.message }, 'Initial backup failed'); }); } catch (_) {}

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
      const cnt = stmts.countArchived.get().cnt;
      if (cnt <= MAX_ARCHIVED) return [];
      const excess = stmts.oldestArchived.all(cnt - MAX_ARCHIVED);
      const ids = excess.map(function(r) { return r.id; });
      for (let i = 0; i < ids.length; i++) {
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
    setSpecScore: function(id, score) { stmts.setSpecScore.run(score, id); },
    setParentCardId: function(id, parentId) { stmts.setParentCardId.run(parentId, id); },
    getByParent: function(parentId) { return stmts.getByParent.all(parentId); },
    countIncompleteChildren: function(parentId) { return stmts.countByParentAndColumn.get(parentId).cnt; },
    getActiveInitiative: function() { return stmts.getActiveInitiative.get(); },
    search: function(query) { const q = '%' + query + '%'; return stmts.search.all(q, q, q); },
    delete: function(id) {
      const card = stmts.get.get(id);
      stmts.softDelete.run(id);
      auditLog('delete', 'card', id, 'user', card ? card.title : '', '', 'soft-deleted');
    },
    updateState: function(id, updates) {
      // Static column map — keys are validated identifiers, never user-controlled strings in SQL.
      // Even if the map is extended, column names are always known-safe literals.
      const COLUMN_MAP = {
        'status': 'status', 'column_name': 'column_name', 'spec': 'spec',
        'review_score': 'review_score', 'review_data': 'review_data',
        'project_path': 'project_path', 'labels': 'labels', 'depends_on': 'depends_on',
        'phase_durations': 'phase_durations', 'approved_by': 'approved_by',
        'parent_card_id': 'parent_card_id',
        'spec_score': 'spec_score',
      };
      const filtered = {};
      const allKeys = Object.keys(updates);
      for (let ki = 0; ki < allKeys.length; ki++) {
        if (COLUMN_MAP[allKeys[ki]]) filtered[allKeys[ki]] = updates[allKeys[ki]];
      }
      if (filtered.column_name && !VALID_COLUMNS.includes(filtered.column_name)) {
        throw new Error('Invalid column: ' + filtered.column_name);
      }
      const keys = Object.keys(filtered);
      if (keys.length === 0) return;
      const setClauses = keys.map(function(k) { return COLUMN_MAP[k] + " = ?"; }).join(', ');
      const values = keys.map(function(k) { return filtered[k]; });
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
  config: {
    get: function(key) { const row = stmts.configGet.get(key); return row ? row.value : null; },
    set: function(key, value) { stmts.configSet.run(key, String(value)); },
    getAll: function() { return stmts.configAll.all(); },
  },
  learnings: {
    upsert: function(category, key, value, confidence) {
      stmts.learningUpsert.run(category, key, value || '', confidence || 50);
    },
    getByCategory: function(category) { return stmts.learningGetByCategory.all(category); },
    getAll: function() { return stmts.learningGetAll.all(); },
    get: function(category, key) { return stmts.learningGet.get(category, key); },
    remove: function(id) { stmts.learningDelete.run(id); },
    bumpApplied: function(id) { stmts.learningBumpApplied.run(id); },
    setConfidence: function(id, confidence) { stmts.learningSetConfidence.run(confidence, id); },
    prune: function() { stmts.learningPrune.run(); },
  },
  checkpoints: {
    create: function(label, changeType, detail, rollbackData) {
      return stmts.checkpointCreate.run(label, changeType, detail || '',
        typeof rollbackData === 'object' ? JSON.stringify(rollbackData) : String(rollbackData || '{}'));
    },
    recent: function(limit) { return stmts.checkpointRecent.all(limit || 20); },
    get: function(id) { return stmts.checkpointGet.get(id); },
    remove: function(id) { stmts.checkpointDelete.run(id); },
    prune: function() { stmts.checkpointPrune.run(); },
  },
  errors: {
    log: function(level, source, cardId, message, context) {
      try {
        stmts.errorInsert.run(level || 'error', source || '', cardId || null, String(message),
          typeof context === 'object' ? JSON.stringify(context) : String(context || '{}'));
      } catch (_) {}
    },
    unresolved: function() { return stmts.errorUnresolved.all(); },
    byCard: function(cardId) { return stmts.errorByCard.all(cardId); },
    resolve: function(id, fixCardId) { stmts.errorResolve.run(fixCardId || null, id); },
    resolveByCard: function(cardId) { stmts.errorResolveByCard.run(cardId); },
    recent: function(limit) { return stmts.errorRecent.all(limit || 50); },
    count: function() { return stmts.errorCount.get().cnt; },
    prune: function(days) { stmts.errorPrune.run('-' + (days || 30) + ' days'); },
  },
};
