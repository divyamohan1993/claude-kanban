const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, '.data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_HOT = path.join(BACKUP_DIR, 'hot');
const BACKUP_HOURLY = path.join(BACKUP_DIR, 'hourly');
const BACKUP_DAILY = path.join(BACKUP_DIR, 'daily');
const DB_PATH = path.join(DATA_DIR, 'kanban.db');
const SNAPSHOT_ROOT = path.join(DATA_DIR, 'snapshots');
const SNAPSHOT_ARCHIVE = path.join(DATA_DIR, 'archive', 'snapshots');
const CUSTOM_PROMPTS_FILE = path.join(DATA_DIR, 'custom-prompts.json');

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || (IS_WIN ? 'R:\\' : path.join(os.homedir(), 'Projects'));

const VALID_COLUMNS = ['brainstorm', 'todo', 'working', 'review', 'done', 'archive'];

const MAX_ARCHIVED = 50;

// Mutable runtime config — editable via control panel
const runtime = {
  maxConcurrentBuilds: Number(process.env.MAX_CONCURRENT_BUILDS) || 1,
  buildTimeoutPolls: Number(process.env.BUILD_TIMEOUT_MINS || 60) * 12,
  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MINS || 15) * 60 * 1000,
  webhookUrl: process.env.WEBHOOK_URL || '',
  maxHourlySessions: Number(process.env.MAX_HOURLY_SESSIONS) || 0,
  maxWeeklySessions: Number(process.env.MAX_WEEKLY_SESSIONS) || 0,
  usagePausePct: Number(process.env.USAGE_PAUSE_PCT) || 80,
  maxDoneVisible: Number(process.env.MAX_DONE_VISIBLE) || 10,
  maxArchiveVisible: Number(process.env.MAX_ARCHIVE_VISIBLE) || 50,
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
  claudeEffort: process.env.CLAUDE_EFFORT || 'high',
  maxFixAttempts: 2,
  maxReviewFixAttempts: 3,
};

// Housekeeping constants
const LOG_RETENTION_DAYS = 7;
const SNAPSHOT_ARCHIVE_RETENTION_DAYS = 14;
const MAX_AUDIT_ROWS = 10000;
const RUNTIME_STALE_HOURS = 24;

// H3 fix: auto-generate ADMIN_PIN if not set
var ADMIN_PIN = process.env.ADMIN_PIN || '';
if (!ADMIN_PIN) {
  // Ensure DATA_DIR exists for storing generated PIN
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  var pinFile = path.join(DATA_DIR, '.generated-pin');
  try {
    if (fs.existsSync(pinFile)) {
      ADMIN_PIN = fs.readFileSync(pinFile, 'utf-8').trim();
    }
  } catch (_) {}
  if (!ADMIN_PIN) {
    ADMIN_PIN = crypto.randomInt(100000, 999999).toString();
    try { fs.writeFileSync(pinFile, ADMIN_PIN); } catch (_) {}
  }
  console.log('\n  *** ADMIN_PIN not set — auto-generated: ' + ADMIN_PIN + ' ***');
  console.log('  Set ADMIN_PIN in .env to use your own. Saved to .data/.generated-pin\n');
}

var PORT = Number(process.env.PORT) || 51777;

module.exports = {
  IS_WIN,
  IS_MAC,
  ROOT_DIR,
  DATA_DIR,
  LOGS_DIR,
  RUNTIME_DIR,
  BACKUP_DIR,
  BACKUP_HOT,
  BACKUP_HOURLY,
  BACKUP_DAILY,
  DB_PATH,
  SNAPSHOT_ROOT,
  SNAPSHOT_ARCHIVE,
  CUSTOM_PROMPTS_FILE,
  PROJECTS_ROOT,
  VALID_COLUMNS,
  MAX_ARCHIVED,
  runtime,
  LOG_RETENTION_DAYS,
  SNAPSHOT_ARCHIVE_RETENTION_DAYS,
  MAX_AUDIT_ROWS,
  RUNTIME_STALE_HOURS,
  PORT: PORT,
  ADMIN_PORT: Number(process.env.ADMIN_PORT) || PORT + 1,
  ADMIN_PIN: ADMIN_PIN,
};
