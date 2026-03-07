const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'kanban.db'));
db.pragma('journal_mode = WAL');

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

const stmts = {
  getAll: db.prepare('SELECT * FROM cards ORDER BY created_at ASC'),
  get: db.prepare('SELECT * FROM cards WHERE id = ?'),
  create: db.prepare('INSERT INTO cards (title, description, column_name) VALUES (?, ?, ?)'),
  update: db.prepare("UPDATE cards SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?"),
  move: db.prepare("UPDATE cards SET column_name = ?, updated_at = datetime('now') WHERE id = ?"),
  setStatus: db.prepare("UPDATE cards SET status = ?, updated_at = datetime('now') WHERE id = ?"),
  setSpec: db.prepare("UPDATE cards SET spec = ?, updated_at = datetime('now') WHERE id = ?"),
  setProjectPath: db.prepare("UPDATE cards SET project_path = ?, updated_at = datetime('now') WHERE id = ?"),
  setSessionLog: db.prepare("UPDATE cards SET session_log = ?, updated_at = datetime('now') WHERE id = ?"),
  setReviewData: db.prepare("UPDATE cards SET review_score = ?, review_data = ?, updated_at = datetime('now') WHERE id = ?"),
  del: db.prepare('DELETE FROM cards WHERE id = ?'),
  createSession: db.prepare('INSERT INTO sessions (card_id, type, pid) VALUES (?, ?, ?)'),
  updateSession: db.prepare("UPDATE sessions SET status = ?, output = ?, completed_at = datetime('now') WHERE id = ?"),
  getSessionsByCard: db.prepare('SELECT * FROM sessions WHERE card_id = ? ORDER BY started_at DESC'),
};

module.exports = {
  db,
  cards: {
    getAll: () => stmts.getAll.all(),
    get: (id) => stmts.get.get(id),
    create: (title, desc, col) => stmts.create.run(title, desc || '', col || 'brainstorm'),
    update: (id, title, desc) => stmts.update.run(title, desc, id),
    move: (id, col) => stmts.move.run(col, id),
    setStatus: (id, status) => stmts.setStatus.run(status, id),
    setSpec: (id, spec) => stmts.setSpec.run(spec, id),
    setProjectPath: (id, p) => stmts.setProjectPath.run(p, id),
    setSessionLog: (id, log) => stmts.setSessionLog.run(log, id),
    setReviewData: (id, score, data) => stmts.setReviewData.run(score, data, id),
    delete: (id) => stmts.del.run(id),
    updateState: (id, updates) => {
      const allowed = ['status', 'column_name', 'spec', 'review_score', 'review_data', 'project_path'];
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
