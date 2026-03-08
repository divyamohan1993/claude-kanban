// =============================================================================
// Intelligence Service — Self-Learning Pattern Engine
// =============================================================================
//
// Learns from user behavior and system patterns. Persists across restarts.
// Every auto-change creates a checkpoint — rollback always available.
//
// Categories:
//   label-rule    : keyword → label mapping (learned from user label assignments)
//   error-remedy  : error pattern → known fix description
//   build-insight : project → avg duration, timeout frequency
//   config-tune   : metric → auto-applied config adjustment
//   prompt-theme  : common feedback/retry words → prompt suggestion
//   workflow-note : general behavioral observations
//

const { cards, learnings, checkpoints, config: dbConfig, auditLog } = require('../db');
const { broadcast } = require('../lib/broadcast');
const { log } = require('../lib/logger');

// --- Label Learning ---

// Common label keywords — seed data for fresh installs.
// Confidence starts low (30) so user-learned patterns quickly overtake them.
const SEED_LABEL_RULES = {
  'fix': 'bug', 'bug': 'bug', 'broken': 'bug', 'crash': 'bug', 'error': 'bug',
  'feat': 'feature', 'feature': 'feature', 'add': 'feature', 'new': 'feature', 'implement': 'feature',
  'refactor': 'refactor', 'cleanup': 'refactor', 'reorganize': 'refactor', 'simplify': 'refactor',
  'test': 'testing', 'spec': 'testing', 'coverage': 'testing',
  'doc': 'docs', 'readme': 'docs', 'documentation': 'docs',
  'style': 'ui', 'css': 'ui', 'design': 'ui', 'layout': 'ui', 'theme': 'ui',
  'perf': 'performance', 'optimize': 'performance', 'speed': 'performance', 'slow': 'performance',
  'security': 'security', 'auth': 'security', 'vuln': 'security', 'xss': 'security',
  'deploy': 'devops', 'ci': 'devops', 'docker': 'devops', 'pipeline': 'devops',
  'api': 'api', 'endpoint': 'api', 'route': 'api', 'rest': 'api',
  'db': 'database', 'database': 'database', 'migration': 'database', 'schema': 'database', 'sql': 'database',
};

function seedLabelRules() {
  const existing = learnings.getByCategory('label-rule');
  if (existing.length > 0) return; // Already seeded
  const keys = Object.keys(SEED_LABEL_RULES);
  for (let i = 0; i < keys.length; i++) {
    learnings.upsert('label-rule', keys[i], SEED_LABEL_RULES[keys[i]], 30);
  }
  log.info({ count: keys.length }, 'Intelligence: seeded label rules');
}

// Learn from user label assignments — extract keywords from title, map to labels.
function learnFromLabels(cardId) {
  const card = cards.get(cardId);
  if (!card || !card.labels || !card.title) return;

  const labelList = card.labels.split(',').map(function(l) { return l.trim().toLowerCase(); }).filter(Boolean);
  if (labelList.length === 0) return;

  // Extract meaningful words from title (3+ chars, lowercase)
  const words = card.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(function(w) { return w.length >= 3; });

  // For each word-label pair, reinforce the mapping
  for (let wi = 0; wi < words.length; wi++) {
    for (let li = 0; li < labelList.length; li++) {
      learnings.upsert('label-rule', words[wi], labelList[li], 50);
    }
  }
}

// Auto-label a card based on learned patterns. Returns labels string or null.
function autoLabel(title, description) {
  const rules = learnings.getByCategory('label-rule');
  if (rules.length === 0) return null;

  const text = ((title || '') + ' ' + (description || '')).toLowerCase();
  const words = text.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function(w) { return w.length >= 3; });

  const labelScores = {};
  for (let wi = 0; wi < words.length; wi++) {
    for (let ri = 0; ri < rules.length; ri++) {
      if (rules[ri].pattern_key === words[wi] && rules[ri].confidence >= 40) {
        const label = rules[ri].pattern_value;
        labelScores[label] = (labelScores[label] || 0) + rules[ri].confidence;
      }
    }
  }

  // Pick labels with score >= 60 (at least one strong match or two weak ones)
  const labels = Object.keys(labelScores).filter(function(l) { return labelScores[l] >= 60; });
  if (labels.length === 0) return null;

  // Cap at 3 auto-labels
  labels.sort(function(a, b) { return labelScores[b] - labelScores[a]; });
  const result = labels.slice(0, 3).join(',');

  // Track which rules were applied
  for (let ai = 0; ai < labels.length && ai < 3; ai++) {
    for (let ri = 0; ri < rules.length; ri++) {
      if (rules[ri].pattern_value === labels[ai]) {
        learnings.bumpApplied(rules[ri].id);
      }
    }
  }

  return result;
}

// When user removes an auto-applied label, reduce confidence of the rule
function penalizeLabel(keyword, label) {
  const rule = learnings.get('label-rule', keyword);
  if (rule && rule.pattern_value === label) {
    const newConf = Math.max(0, rule.confidence - 15);
    learnings.setConfidence(rule.id, newConf);
    if (newConf === 0) learnings.remove(rule.id);
  }
}

// --- Build Insights ---

function learnFromBuild(cardId) {
  const card = cards.get(cardId);
  if (!card || !card.project_path) return;

  const project = require('path').basename(card.project_path);
  let durations = {};
  try { durations = JSON.parse(card.phase_durations || '{}'); } catch (_) {}

  // Track build duration
  if (durations.build && durations.build.duration) {
    const mins = Math.round(durations.build.duration / 60000);
    learnings.upsert('build-insight', 'avg-build-mins:' + project, String(mins), 70);
  }

  // Track review scores
  if (card.review_score > 0) {
    learnings.upsert('build-insight', 'avg-score:' + project, String(card.review_score), 70);
  }
}

// --- Error Remedy Learning ---

function learnFromError(errorMessage, fix) {
  if (!errorMessage || !fix) return;
  // Extract error signature (first 100 chars, normalized)
  const sig = errorMessage.replace(/[0-9]+/g, 'N').replace(/\/[^\s]+/g, '/PATH').slice(0, 100);
  learnings.upsert('error-remedy', sig, fix, 60);
}

function findRemedy(errorMessage) {
  const sig = errorMessage.replace(/[0-9]+/g, 'N').replace(/\/[^\s]+/g, '/PATH').slice(0, 100);
  const remedy = learnings.get('error-remedy', sig);
  return remedy ? remedy.pattern_value : null;
}

// --- Feedback Theme Learning ---

function learnFromFeedback(feedback) {
  if (!feedback || feedback.length < 10) return;
  // Extract 3+ char words, track frequency as prompt themes
  const words = feedback.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(function(w) { return w.length >= 4; });
  const seen = {};
  for (let i = 0; i < words.length; i++) {
    if (seen[words[i]]) continue;
    seen[words[i]] = true;
    learnings.upsert('prompt-theme', words[i], 'feedback-keyword', 30);
  }
}

// --- Config Auto-Tuning ---

// Analyze patterns and auto-apply config changes when confidence is high.
// Every change creates a checkpoint (rollback always available).
function analyzeAndTune() {
  const { runtime } = require('../config');
  const changes = [];

  // 1. Check for frequent build timeouts → increase timeout
  const allCards = cards.getAll().concat(cards.getArchived());
  let timeoutCount = 0;
  let totalBuilds = 0;
  for (let i = 0; i < allCards.length; i++) {
    const c = allCards[i];
    if (c.session_log && c.session_log.includes('TIMEOUT')) timeoutCount++;
    if (c.phase_durations) {
      try {
        const pd = JSON.parse(c.phase_durations);
        if (pd.build) totalBuilds++;
      } catch (_) {}
    }
  }
  if (totalBuilds >= 5 && timeoutCount / totalBuilds > 0.3) {
    const currentTimeout = runtime.buildTimeoutPolls;
    const suggestedPolls = Math.min(currentTimeout * 2, 2880); // cap at 4 hours
    if (suggestedPolls > currentTimeout) {
      changes.push({
        type: 'config-tune',
        key: 'buildTimeoutPolls',
        from: currentTimeout,
        to: suggestedPolls,
        reason: timeoutCount + '/' + totalBuilds + ' builds timed out (' + Math.round(timeoutCount / totalBuilds * 100) + '%)',
      });
    }
  }

  // 2. Check for consistently low review scores → note for prompt improvement
  const scores = allCards.filter(function(c) { return c.review_score > 0; }).map(function(c) { return c.review_score; });
  if (scores.length >= 5) {
    const avg = scores.reduce(function(a, b) { return a + b; }, 0) / scores.length;
    if (avg < 6) {
      learnings.upsert('workflow-note', 'low-avg-review-score',
        'Average review score is ' + avg.toFixed(1) + '/10 across ' + scores.length + ' reviews. Consider strengthening build instructions.', 70);
    }
  }

  // 3. Check for repeated retry feedback themes → suggest prompt additions
  const themes = learnings.getByCategory('prompt-theme');
  const highFreq = themes.filter(function(t) { return t.occurrences >= 5 && t.confidence >= 50; });
  if (highFreq.length > 0) {
    const topWords = highFreq.slice(0, 5).map(function(t) { return t.pattern_key + ' (' + t.occurrences + 'x)'; }).join(', ');
    learnings.upsert('workflow-note', 'common-feedback-themes',
      'Frequent retry feedback keywords: ' + topWords + '. Consider adding to custom build instructions.', 60);
  }

  // Apply config changes (with checkpoint)
  for (let ci = 0; ci < changes.length; ci++) {
    const ch = changes[ci];
    // Check if we already applied this tune recently
    const existing = learnings.get('config-tune', ch.key);
    if (existing && existing.applied > 0) continue; // Already auto-tuned once — don't pile on

    // Create checkpoint before changing
    checkpoint('Auto-tune: ' + ch.key, 'config-tune', ch.reason, { key: ch.key, oldValue: ch.from });

    // Apply
    runtime[ch.key] = ch.to;
    learnings.upsert('config-tune', ch.key, String(ch.to), 80);

    auditLog('auto-tune', 'config', null, 'intelligence', String(ch.from), String(ch.to), ch.reason);
    broadcast('toast', { message: 'Auto-tuned ' + ch.key + ': ' + ch.from + ' → ' + ch.to + ' (' + ch.reason + ')', type: 'info' });
    log.info({ key: ch.key, from: ch.from, to: ch.to, reason: ch.reason }, 'Intelligence auto-tuned config');
  }

  // Prune stale learnings (low confidence, old, rarely seen)
  learnings.prune();
  checkpoints.prune();

  return changes;
}

// --- Checkpoint / Rollback ---

function checkpoint(label, changeType, detail, rollbackData) {
  checkpoints.create(label, changeType, detail, rollbackData);
}

function getCheckpoints(limit) {
  return checkpoints.recent(limit || 20);
}

function rollback(checkpointId) {
  const cp = checkpoints.get(checkpointId);
  if (!cp) return { success: false, reason: 'Checkpoint not found' };

  let data;
  try { data = JSON.parse(cp.rollback_data); } catch (_) {
    return { success: false, reason: 'Invalid rollback data' };
  }

  const result = { success: true, label: cp.label, reverted: [] };

  // Rollback config changes
  if (cp.change_type === 'config-tune' && data.key && data.oldValue !== undefined) {
    const { runtime } = require('../config');
    runtime[data.key] = data.oldValue;
    result.reverted.push(data.key + ' → ' + data.oldValue);
    auditLog('rollback', 'config', null, 'user', '', cp.label, 'checkpoint #' + cp.id);
  }

  // Rollback label changes
  if (cp.change_type === 'auto-label' && data.cardId) {
    const card = cards.get(data.cardId);
    if (card) {
      cards.setLabels(data.cardId, data.oldLabels || '');
      result.reverted.push('Card #' + data.cardId + ' labels → "' + (data.oldLabels || '') + '"');
      broadcast('card-updated', cards.get(data.cardId));
    }
  }

  // Rollback custom prompts
  if (cp.change_type === 'auto-prompt' && data.oldPrompts) {
    try {
      const usageSvc = require('./usage');
      usageSvc.setCustomPrompts(data.oldPrompts);
      result.reverted.push('Custom prompts restored');
    } catch (_) {}
  }

  checkpoints.remove(checkpointId);
  broadcast('toast', { message: 'Rolled back: ' + cp.label, type: 'success' });

  return result;
}

// --- Insights API ---

function getInsights() {
  const all = learnings.getAll();
  const grouped = {};
  for (let i = 0; i < all.length; i++) {
    const cat = all[i].category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({
      id: all[i].id,
      key: all[i].pattern_key,
      value: all[i].pattern_value,
      confidence: all[i].confidence,
      occurrences: all[i].occurrences,
      applied: all[i].applied,
      lastSeen: all[i].last_seen,
    });
  }
  return {
    learnings: grouped,
    totalPatterns: all.length,
    checkpoints: checkpoints.recent(10),
  };
}

function removeLearning(id) {
  learnings.remove(id);
}

// --- Init ---

function init() {
  seedLabelRules();
  log.info({ patterns: learnings.getAll().length }, 'Intelligence service initialized');
}

module.exports = {
  init: init,
  // Label intelligence
  autoLabel: autoLabel,
  learnFromLabels: learnFromLabels,
  penalizeLabel: penalizeLabel,
  // Build / error / feedback learning
  learnFromBuild: learnFromBuild,
  learnFromError: learnFromError,
  findRemedy: findRemedy,
  learnFromFeedback: learnFromFeedback,
  // Analysis
  analyzeAndTune: analyzeAndTune,
  getInsights: getInsights,
  removeLearning: removeLearning,
  // Checkpoint / rollback
  checkpoint: checkpoint,
  getCheckpoints: getCheckpoints,
  rollback: rollback,
};
