const fs = require('fs');
const path = require('path');
const os = require('os');
const { runtime, CUSTOM_PROMPTS_FILE, PROJECTS_ROOT } = require('../config');
const { broadcast } = require('../lib/broadcast');
const { usage, backups, config: dbConfig } = require('../db');
const { sendWebhook, isBlockedWebhookUrl } = require('../lib/helpers');

// --- Claude Max Usage (real plan limits from API) ---

let _usageCache = { data: null, fetchedAt: 0 };
const USAGE_CACHE_TTL = 55 * 60 * 1000; // ~1 hour

function fetchClaudeUsage(force) {
  if (!force && _usageCache.data && (Date.now() - _usageCache.fetchedAt < USAGE_CACHE_TTL)) {
    return Promise.resolve(_usageCache.data);
  }

  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  } catch (_) {
    return Promise.resolve(null);
  }

  const token = creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
  if (!token) return Promise.resolve(null);

  return new Promise(function(resolve) {
    const https = require('https');
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }, function(res) {
      let body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        try {
          const data = JSON.parse(body);
          _usageCache.data = data;
          _usageCache.fetchedAt = Date.now();
          resolve(data);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(10000, function() { req.destroy(); resolve(null); });
    req.end();
  });
}

// Check self-imposed + plan usage limits. Returns { allowed, reason? }.
// Accepts pipelineState object from pipeline to avoid circular dep.
function checkUsageLimits(pipelineState) {
  const hourly = usage.hourly();
  const weekly = usage.weekly();
  const hitHourly = runtime.maxHourlySessions > 0 && hourly >= runtime.maxHourlySessions;
  const hitWeekly = runtime.maxWeeklySessions > 0 && weekly >= runtime.maxWeeklySessions;

  if (hitHourly || hitWeekly) {
    const reason = hitHourly
      ? 'Session limit reached (' + hourly + '/' + runtime.maxHourlySessions + '/hr)'
      : 'Weekly session limit reached (' + weekly + '/' + runtime.maxWeeklySessions + '/wk)';
    if (pipelineState && !pipelineState.paused) {
      pipelineState.pause();
      broadcast('toast', { message: 'Pipeline auto-paused: ' + reason, type: 'error' });
      sendWebhook('usage-limit', { reason: reason, hourly: hourly, weekly: weekly });
    }
    return { allowed: false, reason: reason };
  }

  const cached = _usageCache.data;
  if (cached) {
    const sessionPct = cached.five_hour ? cached.five_hour.utilization : 0;
    const weeklyPct = cached.seven_day ? cached.seven_day.utilization : 0;
    const overSession = sessionPct >= runtime.usagePausePct;
    const overWeekly = weeklyPct >= runtime.usagePausePct;

    if (overSession || overWeekly) {
      const reason = overSession
        ? 'Claude Max session at ' + sessionPct + '% (limit: ' + runtime.usagePausePct + '%)'
        : 'Claude Max weekly at ' + weeklyPct + '% (limit: ' + runtime.usagePausePct + '%)';
      if (pipelineState && !pipelineState.paused) {
        pipelineState.pause();
        broadcast('toast', { message: 'Pipeline auto-paused: ' + reason, type: 'error' });
        sendWebhook('usage-limit', { reason: reason, session: sessionPct, weekly: weeklyPct });
      }
      return { allowed: false, reason: reason };
    }
  }

  return { allowed: true };
}

function getUsageStats() {
  const planData = _usageCache.data;
  return {
    plan: planData ? {
      session: { utilization: planData.five_hour ? planData.five_hour.utilization : null, resetsAt: planData.five_hour ? planData.five_hour.resets_at : null },
      weekly: { utilization: planData.seven_day ? planData.seven_day.utilization : null, resetsAt: planData.seven_day ? planData.seven_day.resets_at : null },
      sonnet: planData.seven_day_sonnet ? { utilization: planData.seven_day_sonnet.utilization, resetsAt: planData.seven_day_sonnet.resets_at } : null,
      extraUsage: planData.extra_usage || null,
      pauseThreshold: runtime.usagePausePct,
      cachedAt: _usageCache.fetchedAt ? new Date(_usageCache.fetchedAt).toISOString() : null,
    } : null,
    board: {
      hourly: { count: usage.hourly(), limit: runtime.maxHourlySessions || null },
      weekly: { count: usage.weekly(), limit: runtime.maxWeeklySessions || null },
      hourlyBreakdown: usage.breakdown('-1 hour'),
      weeklyBreakdown: usage.breakdown('-7 days'),
    },
  };
}

// --- Runtime Configuration ---

// H2 fix: getConfig returns only what the caller needs.
// Public callers get runtime config only. Admin callers get full env/status.
function getConfig(pipelineState, opts) {
  const isAdmin = opts && opts.admin;
  const result = {
    runtime: {
      maxConcurrentBuilds: runtime.maxConcurrentBuilds,
      buildTimeoutMins: Math.round(runtime.buildTimeoutPolls / 12),
      idleTimeoutMins: Math.round(runtime.idleTimeoutMs / 60000),
      usagePausePct: runtime.usagePausePct,
      maxHourlySessions: runtime.maxHourlySessions,
      maxWeeklySessions: runtime.maxWeeklySessions,
      maxReviewFixAttempts: runtime.maxReviewFixAttempts,
      maxFixAttempts: runtime.maxFixAttempts,
      maxDoneVisible: runtime.maxDoneVisible,
      maxArchiveVisible: runtime.maxArchiveVisible,
      backupRetentionDays: backups.getRetentionDays(),
      claudeModel: runtime.claudeModel,
      claudeEffort: runtime.claudeEffort,
      webhookUrl: isAdmin ? runtime.webhookUrl : (runtime.webhookUrl ? '[configured]' : ''),
    },
    status: pipelineState ? {
      pipelinePaused: pipelineState.paused,
      activeBuilds: pipelineState.activeCount,
      queueLength: pipelineState.queueLength,
    } : {},
  };
  // Admin-only: server internals (PID, memory, uptime, node version, full paths)
  if (isAdmin) {
    result.env = {
      port: process.env.PORT || 51777,
      projectsRoot: PROJECTS_ROOT,
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    };
    result.status.activeFixes = pipelineState ? pipelineState.fixCount : 0;
    result.status.activePollers = pipelineState ? pipelineState.pollerCount : 0;
  }
  return result;
}

function setConfig(updates) {
  const changed = {};
  if (updates.maxConcurrentBuilds !== undefined) { runtime.maxConcurrentBuilds = Math.max(1, Number(updates.maxConcurrentBuilds)); changed.maxConcurrentBuilds = runtime.maxConcurrentBuilds; }
  if (updates.buildTimeoutMins !== undefined) { runtime.buildTimeoutPolls = Math.max(1, Number(updates.buildTimeoutMins)) * 12; changed.buildTimeoutMins = Math.round(runtime.buildTimeoutPolls / 12); }
  if (updates.idleTimeoutMins !== undefined) { runtime.idleTimeoutMs = Math.max(1, Number(updates.idleTimeoutMins)) * 60000; changed.idleTimeoutMins = Math.round(runtime.idleTimeoutMs / 60000); }
  if (updates.usagePausePct !== undefined) { runtime.usagePausePct = Math.max(1, Math.min(100, Number(updates.usagePausePct))); changed.usagePausePct = runtime.usagePausePct; }
  if (updates.maxHourlySessions !== undefined) { runtime.maxHourlySessions = Math.max(0, Number(updates.maxHourlySessions)); changed.maxHourlySessions = runtime.maxHourlySessions; }
  if (updates.maxWeeklySessions !== undefined) { runtime.maxWeeklySessions = Math.max(0, Number(updates.maxWeeklySessions)); changed.maxWeeklySessions = runtime.maxWeeklySessions; }
  if (updates.maxReviewFixAttempts !== undefined) { runtime.maxReviewFixAttempts = Math.max(0, Number(updates.maxReviewFixAttempts)); changed.maxReviewFixAttempts = runtime.maxReviewFixAttempts; }
  if (updates.maxFixAttempts !== undefined) { runtime.maxFixAttempts = Math.max(0, Number(updates.maxFixAttempts)); changed.maxFixAttempts = runtime.maxFixAttempts; }
  if (updates.maxDoneVisible !== undefined) { runtime.maxDoneVisible = Math.max(0, Number(updates.maxDoneVisible)); changed.maxDoneVisible = runtime.maxDoneVisible; }
  if (updates.maxArchiveVisible !== undefined) { runtime.maxArchiveVisible = Math.max(0, Number(updates.maxArchiveVisible)); changed.maxArchiveVisible = runtime.maxArchiveVisible; }
  if (updates.backupRetentionDays !== undefined) { backups.setRetentionDays(updates.backupRetentionDays); changed.backupRetentionDays = backups.getRetentionDays(); }
  if (updates.claudeModel !== undefined) {
    const model = String(updates.claudeModel);
    if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(model)) { runtime.claudeModel = model; changed.claudeModel = model; }
  }
  if (updates.claudeEffort !== undefined) {
    const effort = String(updates.claudeEffort);
    if (['low', 'medium', 'high'].includes(effort)) { runtime.claudeEffort = effort; changed.claudeEffort = effort; }
  }
  if (updates.webhookUrl !== undefined) {
    const newUrl = String(updates.webhookUrl);
    if (newUrl && isBlockedWebhookUrl(newUrl)) { changed._webhookError = 'Webhook URL blocked: internal/private IP addresses not allowed'; }
    else { runtime.webhookUrl = newUrl; changed.webhookUrl = runtime.webhookUrl; }
  }
  broadcast('config-updated', getConfig());
  return changed;
}

// --- Custom Prompts (stored in DB config table) ---

const CUSTOM_PROMPT_DEFAULTS = { buildInstructions: '', reviewCriteria: '', brainstormInstructions: '', qualityGates: '' };

function getCustomPrompts() {
  // Migrate from legacy JSON file to DB on first read
  const raw = dbConfig.get('custom_prompts');
  if (raw) {
    try { return JSON.parse(raw); } catch (_) {}
  }
  // One-time migration from file → DB
  try {
    const fileData = JSON.parse(fs.readFileSync(CUSTOM_PROMPTS_FILE, 'utf-8'));
    dbConfig.set('custom_prompts', JSON.stringify(fileData));
    return fileData;
  } catch (_) {}
  return Object.assign({}, CUSTOM_PROMPT_DEFAULTS);
}

function setCustomPrompts(prompts) {
  const data = getCustomPrompts();
  if (prompts.buildInstructions !== undefined) data.buildInstructions = prompts.buildInstructions;
  if (prompts.reviewCriteria !== undefined) data.reviewCriteria = prompts.reviewCriteria;
  if (prompts.brainstormInstructions !== undefined) data.brainstormInstructions = prompts.brainstormInstructions;
  if (prompts.qualityGates !== undefined) data.qualityGates = prompts.qualityGates;
  dbConfig.set('custom_prompts', JSON.stringify(data));
  return data;
}

module.exports = {
  fetchClaudeUsage: fetchClaudeUsage,
  checkUsageLimits: checkUsageLimits,
  getUsageStats: getUsageStats,
  getConfig: getConfig,
  setConfig: setConfig,
  getCustomPrompts: getCustomPrompts,
  setCustomPrompts: setCustomPrompts,
  USAGE_CACHE_TTL: USAGE_CACHE_TTL,
};
