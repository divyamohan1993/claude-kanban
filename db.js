const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '.data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'kanban.db'));
db.pragma('journal_mode = WAL');
db.pragma('optimize');

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    spec TEXT DEFAULT '',
    column_name TEXT NOT NULL DEFAULT 'brainstorm',
    status TEXT NOT NULL DEFAULT 'idle',
    project_path TEXT DEFAULT '',
    session_log TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    status TEXT DEFAULT 'running',
    pid INTEGER,
    output TEXT DEFAULT '',
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
`);

// Schema migrations — safe to re-run
try { db.exec('ALTER TABLE cards ADD COLUMN review_score INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE cards ADD COLUMN review_data TEXT DEFAULT ""'); } catch (_) {}
try { db.exec('ALTER TABLE cards ADD COLUMN labels TEXT DEFAULT ""'); } catch (_) {}
try { db.exec('ALTER TABLE cards ADD COLUMN depends_on TEXT DEFAULT ""'); } catch (_) {}
try { db.exec('ALTER TABLE cards ADD COLUMN phase_durations TEXT DEFAULT ""'); } catch (_) {}
try { db.exec('ALTER TABLE cards ADD COLUMN approved_by TEXT DEFAULT ""'); } catch (_) {}

const MAX_ARCHIVED = 50;

const stmts = {
  getAll: db.prepare("SELECT * FROM cards WHERE column_name != 'archive' ORDER BY created_at ASC"),
  getArchived: db.prepare("SELECT * FROM cards WHERE column_name = 'archive' ORDER BY updated_at DESC"),
  countArchived: db.prepare("SELECT COUNT(*) as cnt FROM cards WHERE column_name = 'archive'"),
  oldestArchived: db.prepare("SELECT id FROM cards WHERE column_name = 'archive' ORDER BY updated_at ASC LIMIT ?"),
  get: db.prepare('SELECT * FROM cards WHERE id = ?'),
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
  search: db.prepare("SELECT * FROM cards WHERE (title LIKE ? OR description LIKE ? OR labels LIKE ?) ORDER BY updated_at DESC LIMIT 50"),
  del: db.prepare('DELETE FROM cards WHERE id = ?'),
  createSession: db.prepare('INSERT INTO sessions (card_id, type, pid) VALUES (?, ?, ?)'),
  updateSession: db.prepare("UPDATE sessions SET status = ?, output = ?, completed_at = datetime('now') WHERE id = ?"),
  getSessionsByCard: db.prepare('SELECT * FROM sessions WHERE card_id = ? ORDER BY started_at DESC'),
};

// Periodic DB maintenance: WAL checkpoint + optimize every 5 min
setInterval(() => {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    db.pragma('optimize');
  } catch (_) {}
}, 5 * 60 * 1000);

module.exports = {
  db,
  cards: {
    getAll: () => stmts.getAll.all(),
    getArchived: () => stmts.getArchived.all(),
    rotateArchive: () => {
      const { cnt } = stmts.countArchived.get();
      if (cnt <= MAX_ARCHIVED) return [];
      const excess = stmts.oldestArchived.all(cnt - MAX_ARCHIVED);
      const ids = excess.map(r => r.id);
      for (const id of ids) stmts.del.run(id);
      return ids;
    },
    get: (id) => stmts.get.get(id),
    create: (title, desc, col) => stmts.create.run(title, desc || '', col || 'brainstorm'),
    update: (id, title, desc) => stmts.update.run(title, desc, id),
    move: (id, col) => stmts.move.run(col, id),
    setStatus: (id, status) => stmts.setStatus.run(status, id),
    setSpec: (id, spec) => stmts.setSpec.run(spec, id),
    setProjectPath: (id, p) => stmts.setProjectPath.run(p, id),
    setSessionLog: (id, log) => stmts.setSessionLog.run(log, id),
    setReviewData: (id, score, data) => stmts.setReviewData.run(score, data, id),
    setApprovedBy: (id, by) => stmts.setApprovedBy.run(by, id),
    setLabels: (id, labels) => stmts.setLabels.run(labels, id),
    setDependsOn: (id, deps) => stmts.setDependsOn.run(deps, id),
    setPhaseDurations: (id, durations) => stmts.setPhaseDurations.run(durations, id),
    search: (query) => { const q = '%' + query + '%'; return stmts.search.all(q, q, q); },
    delete: (id) => stmts.del.run(id),
    updateState: (id, updates) => {
      const allowed = ['status', 'column_name', 'spec', 'review_score', 'review_data', 'project_path', 'labels', 'depends_on', 'phase_durations', 'approved_by'];
      const filtered = {};
      for (const k of Object.keys(updates)) {
        if (allowed.includes(k)) filtered[k] = updates[k];
      }
      const keys = Object.keys(filtered);
      if (keys.length === 0) return;
      const setClauses = keys.map(k => k + " = ?").join(', ');
      const values = keys.map(k => filtered[k]);
      db.prepare("UPDATE cards SET " + setClauses + ", updated_at = datetime('now') WHERE id = ?").run(...values, id);
    },
  },
  sessions: {
    create: (cardId, type, pid) => stmts.createSession.run(cardId, type, pid),
    update: (id, status, output) => stmts.updateSession.run(status, output, id),
    getByCard: (cardId) => stmts.getSessionsByCard.all(cardId),
  },
};
