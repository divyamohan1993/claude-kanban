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

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(os.homedir(), 'Projects');

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

  // --- Single-Project Mode ---
  // 'global' = multi-project (existing), 'single-project' = autonomous single folder
  mode: process.env.KANBAN_MODE || 'global',
  // Locked project folder. Empty + single-project → parent of ROOT_DIR.
  singleProjectPath: process.env.SINGLE_PROJECT_PATH || '',
  // true = brainstorm auto-decomposes into todo and auto-queues (fully autonomous)
  // false = brainstorm stays for human to manually approve/promote to todo
  autoPromoteBrainstorm: (process.env.AUTO_PROMOTE_BRAINSTORM || 'true') === 'true',
  // Max brainstorm cards queued/active at once in single-project mode
  maxBrainstormQueue: Number(process.env.MAX_BRAINSTORM_QUEUE) || 3,
  // Auto-discovery scan interval (minutes). 0 = disabled.
  discoveryIntervalMins: Number(process.env.DISCOVERY_INTERVAL_MINS) || 30,
  // Max child todo cards per brainstorm initiative
  maxChildCards: Number(process.env.MAX_CHILD_CARDS) || 10,

  // --- Spec Intelligence ---
  // Multi-lens brainstorm: forces multi-perspective analysis before spec writing
  multiLensBrainstorm: (process.env.MULTI_LENS_BRAINSTORM || 'true') === 'true',
  // Percentage of brainstorms that receive a creative thinking constraint (0-100)
  creativeConstraintPct: Number(process.env.CREATIVE_CONSTRAINT_PCT) || 20,
  // Spec feedback loop: scores spec effectiveness, learns patterns over time
  specFeedbackLoop: (process.env.SPEC_FEEDBACK_LOOP || 'true') === 'true',
  // Percentage of brainstorms that receive confrontational spec challenges (0-100)
  confrontationalPct: Number(process.env.CONFRONTATIONAL_PCT) || 70,
  // Spec approval gate: if true, brainstorm outputs go to 'spec-ready' status for human approval
  specApprovalGate: (process.env.SPEC_APPROVAL_GATE || 'false') === 'true',

  // --- Rate-Limit Recovery ---
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS) || 30 * 1000,
  rateLimitMinPolls: Number(process.env.RATE_LIMIT_MIN_POLLS) || 6,

  // --- Polling & Timeouts ---
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 5000,
  brainstormTimeoutMins: Number(process.env.BRAINSTORM_TIMEOUT_MINS) || 30,
  decomposeTimeoutMins: Number(process.env.DECOMPOSE_TIMEOUT_MINS) || 15,
  selfHealTimeoutMins: Number(process.env.SELF_HEAL_TIMEOUT_MINS) || 10,
  discoveryTimeoutMins: Number(process.env.DISCOVERY_TIMEOUT_MINS) || 30,

  // --- Rate Limiting ---
  rateLimitGeneralBurst: Number(process.env.RATE_LIMIT_GENERAL_BURST) || 200,
  rateLimitGeneralRefill: Number(process.env.RATE_LIMIT_GENERAL_REFILL) || 100,
  rateLimitAuthBurst: Number(process.env.RATE_LIMIT_AUTH_BURST) || 5,
  rateLimitAuthRefill: Number(process.env.RATE_LIMIT_AUTH_REFILL) || 1,
  sseMaxPerIp: Number(process.env.SSE_MAX_PER_IP) || 5,
  sseMaxTotal: Number(process.env.SSE_MAX_TOTAL) || 200,

  // --- Sessions ---
  sessionMaxAgeMins: Number(process.env.SESSION_MAX_AGE_MINS) || 1440,
  maxSessions: Number(process.env.MAX_SESSIONS) || 10000,
  jwtTtlMins: Number(process.env.JWT_TTL_MINS) || 1440,

  // --- Data Retention ---
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS) || 7,
  snapshotArchiveRetentionDays: Number(process.env.SNAPSHOT_ARCHIVE_RETENTION_DAYS) || 14,
  maxAuditRows: Number(process.env.MAX_AUDIT_ROWS) || 10000,
  runtimeStaleHours: Number(process.env.RUNTIME_STALE_HOURS) || 24,
  maxArchived: Number(process.env.MAX_ARCHIVED) || 50,

  // --- Intelligence Thresholds ---
  autoLabelConfidence: Number(process.env.AUTO_LABEL_CONFIDENCE) || 40,
  labelScoreThreshold: Number(process.env.LABEL_SCORE_THRESHOLD) || 60,
  maxAutoLabels: Number(process.env.MAX_AUTO_LABELS) || 3,

  // --- Card & Snapshot Limits ---
  maxTotalCards: Number(process.env.MAX_TOTAL_CARDS) || 500,
  snapshotMaxFileSizeMb: Number(process.env.SNAPSHOT_MAX_FILE_SIZE_MB) || 10,

  // --- Server Intervals ---
  logScanIntervalSecs: Number(process.env.LOG_SCAN_INTERVAL_SECS) || 30,
  analysisIntervalMins: Number(process.env.ANALYSIS_INTERVAL_MINS) || 30,
  housekeepingIntervalMins: Number(process.env.HOUSEKEEPING_INTERVAL_MINS) || 60,

  // --- Error Handling ---
  maxUncaughtBeforeExit: Number(process.env.MAX_UNCAUGHT_BEFORE_EXIT) || 10,

  // --- Usage Recovery ---
  usageCacheTtlMins: Number(process.env.USAGE_CACHE_TTL_MINS) || 55,
  maxRecoveryWaitHours: Number(process.env.MAX_RECOVERY_WAIT_HOURS) || 6,
  recoveryFallbackMins: Number(process.env.RECOVERY_FALLBACK_MINS) || 30,
  maxRecoveryPollsPerHour: Number(process.env.MAX_RECOVERY_POLLS_PER_HOUR) || 2,
};

// Legacy aliases — use runtime.xxx in new code
const LOG_RETENTION_DAYS = 7;
const SNAPSHOT_ARCHIVE_RETENTION_DAYS = 14;
const MAX_AUDIT_ROWS = 10000;
const RUNTIME_STALE_HOURS = 24;

// Ensure DATA_DIR exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Resolve effective project path for single-project mode
function getEffectiveProjectPath() {
  if (runtime.mode !== 'single-project') return null;
  if (runtime.singleProjectPath) return path.resolve(runtime.singleProjectPath);
  // Default: parent of ROOT_DIR (claude-kanban/ lives inside the project)
  return path.resolve(ROOT_DIR, '..');
}

const PORT = Number(process.env.PORT) || 51777;

// Admin port: env override or random ephemeral port each start
const ADMIN_PORT = process.env.ADMIN_PORT
  ? Number(process.env.ADMIN_PORT)
  : 49152 + crypto.randomInt(16383); // 49152–65535

// Admin path: env override or random 52-char hex string each start
const ADMIN_PATH = process.env.ADMIN_PATH
  ? process.env.ADMIN_PATH.replace(/^\/+|\/+$/g, '')
  : crypto.randomBytes(26).toString('hex'); // 52 hex chars

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
  ADMIN_PORT: ADMIN_PORT,
  ADMIN_PATH: ADMIN_PATH,
  getEffectiveProjectPath: getEffectiveProjectPath,
};
