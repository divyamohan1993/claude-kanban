/**
 * Simulation Mode — Showcases the Claude Kanban pipeline without using any AI tokens.
 * Follows the EXACT same pipeline as prod: one card at a time through
 * todo → working → review → done (or rejected back to todo).
 */

const { cards, config: dbConfig } = require('../db');
const { broadcast } = require('../lib/broadcast');
const { log } = require('../lib/logger');

const MAX_SIM_CARDS = 10; // Hard cap — never more than this on the board

const SIM_IDEAS = [
  { title: 'Add dark mode toggle with system preference detection', description: 'Detect prefers-color-scheme and add a manual toggle that persists in localStorage.', labels: 'feature', score: 9 },
  { title: 'Fix XSS vulnerability in user comment rendering', description: 'Sanitize HTML in comment display to prevent stored XSS attacks via malicious input.', labels: 'security', score: 10 },
  { title: 'Implement lazy loading for dashboard images', description: 'Use Intersection Observer to defer offscreen image loading, reducing initial LCP by ~40%.', labels: 'perf', score: 8 },
  { title: 'Add keyboard navigation for data table', description: 'Arrow keys to navigate cells, Enter to edit, Escape to cancel. WCAG 2.2 AA compliance.', labels: 'feature', score: 9 },
  { title: 'Fix race condition in concurrent form submissions', description: 'Debounce submit handler and add optimistic locking to prevent duplicate entries.', labels: 'bug', score: 4 },
  { title: 'Refactor authentication middleware into composable guards', description: 'Split monolithic auth middleware into role-based, rate-limit, and session guards.', labels: 'refactor', score: 6 },
  { title: 'Add real-time WebSocket notifications', description: 'Replace polling with WebSocket for instant updates on card state changes and mentions.', labels: 'feature', score: 9 },
  { title: 'Implement CSP nonce-based script loading', description: 'Generate per-request nonces for inline scripts, eliminating unsafe-inline CSP directive.', labels: 'security', score: 10 },
  { title: 'Add search with fuzzy matching and filters', description: 'Implement Levenshtein-based fuzzy search with label, status, and date range filters.', labels: 'feature', score: 8 },
  { title: 'Fix memory leak in SSE connection handler', description: 'Properly clean up event listeners and buffers when SSE clients disconnect.', labels: 'bug', score: 3 },
  { title: 'Implement database connection pooling', description: 'Replace single connection with pool of 5, reducing p99 latency from 180ms to 45ms.', labels: 'perf', score: 9 },
  { title: 'Add automated backup verification', description: 'After each backup, restore to temp DB and validate row counts match source.', labels: 'chore', score: 7 },
  { title: 'Fix timezone handling in date displays', description: 'Convert all timestamps to user local timezone using Intl.DateTimeFormat API.', labels: 'bug', score: 8 },
  { title: 'Add rate limiting with sliding window algorithm', description: 'Replace fixed-window rate limiter with sliding window for smoother traffic handling.', labels: 'security', score: 9 },
  { title: 'Add end-to-end encryption for sensitive fields', description: 'AES-256-GCM encryption for PII fields with per-tenant key rotation.', labels: 'security', score: 10 },
  { title: 'Optimize bundle size with tree shaking', description: 'Analyze and remove dead code paths, reducing JS payload from 340KB to 180KB gzipped.', labels: 'perf', score: 5 },
];

// --- State ---
var simActive = false;
var simTimer = null; // single loop timer
var simCardIds = [];

function isSimActive() { return simActive; }

// --- Helpers ---

function getSimCards() {
  return cards.getAll().filter(function(c) { return c.title && c.title.indexOf('[SIM]') === 0; });
}

function isPipelineBusy() {
  var sim = getSimCards();
  for (var i = 0; i < sim.length; i++) {
    if (sim[i].column_name === 'working' || sim[i].column_name === 'review') return true;
  }
  return false;
}

function activity(cardId, step, detail) {
  broadcast('card-activity', { cardId: cardId, step: step, detail: detail, timestamp: Date.now() });
}

var _waitTimers = [];
function wait(ms) {
  return new Promise(function(r) {
    var t = setTimeout(r, ms);
    _waitTimers.push(t);
  });
}

function clearAllTimers() {
  for (var i = 0; i < _waitTimers.length; i++) clearTimeout(_waitTimers[i]);
  _waitTimers = [];
  if (simTimer) { clearTimeout(simTimer); simTimer = null; }
}

// --- Start / Stop ---

function startSimulation() {
  if (simActive) return { error: 'Simulation already running' };
  simActive = true;
  simCardIds = [];
  dbConfig.set('simulation-mode', 'true');

  try { require('./pipeline').skipDemoTimer(); } catch (_) {}
  broadcast('simulation-state', { active: true });
  broadcast('demo-timer', { active: false, nextRunAt: 0, remaining: 0 });
  log.info('Simulation started');

  // Seed: 2 todo + 3 done, then start the loop
  seedBoard();
  runLoop();

  return { active: true };
}

function stopSimulation() {
  simActive = false;
  dbConfig.set('simulation-mode', 'false');
  clearAllTimers();

  // Delete ALL sim cards (including DB orphans from previous runs)
  var all = cards.getAll();
  for (var i = 0; i < all.length; i++) {
    if (all[i].title && all[i].title.indexOf('[SIM]') === 0) {
      try { cards.delete(all[i].id); } catch (_) {}
    }
  }
  simCardIds = [];

  broadcast('board-reload', {});
  broadcast('simulation-state', { active: false });
  broadcast('toast', { message: 'Simulation stopped — all sim cards removed', type: 'info' });
  log.info('Simulation stopped');
  return { active: false };
}

function cleanupSimCards() {
  stopSimulation();
  return { cleaned: true };
}

// --- Seed ---

function seedBoard() {
  var shuffled = SIM_IDEAS.slice().sort(function() { return Math.random() - 0.5; });
  var idx = 0;

  // 2 in todo
  for (var t = 0; t < 2 && idx < shuffled.length; t++, idx++) {
    createCard(shuffled[idx], 'todo', 'queued');
  }

  // 3 in done with scores and durations
  for (var d = 0; d < 3 && idx < shuffled.length; d++, idx++) {
    var c = createCard(shuffled[idx], 'done', 'complete');
    cards.setReviewData(c.id, shuffled[idx].score, '{}');
    cards.setApprovedBy(c.id, shuffled[idx].score >= 8 ? 'ai' : 'human');
    cards.setPhaseDurations(c.id, JSON.stringify({
      brainstorm: { duration: 60000 + Math.floor(Math.random() * 120000) },
      build: { duration: 120000 + Math.floor(Math.random() * 180000) },
      review: { duration: 30000 + Math.floor(Math.random() * 60000) },
    }));
    broadcast('card-updated', cards.get(c.id));
  }
}

function createCard(idea, column, status) {
  var result = cards.create('[SIM] ' + idea.title, idea.description || '', column);
  var id = Number(result.lastInsertRowid);
  simCardIds.push(id);
  cards.setStatus(id, status);
  if (idea.labels) cards.setLabels(id, idea.labels);
  cards.setProjectPath(id, '/sim/project');
  broadcast('card-created', cards.get(id));
  return cards.get(id);
}

// --- Main Loop ---
// Exactly mirrors prod: one card at a time through the full pipeline.

async function runLoop() {
  while (simActive) {
    try {
      // Wait until pipeline is free
      while (simActive && isPipelineBusy()) { await wait(5000); }
      if (!simActive) break;

      // Brief pause between cards
      await wait(3000);
      if (!simActive) break;

      // Cap total sim cards
      var simCards = getSimCards();
      if (simCards.length >= MAX_SIM_CARDS) {
        // Remove oldest done cards to make room
        var doneCards = simCards.filter(function(c) { return c.column_name === 'done'; });
        while (doneCards.length > 3 && simCards.length >= MAX_SIM_CARDS) {
          var oldest = doneCards.pop();
          try { cards.delete(oldest.id); } catch (_) {}
          broadcast('card-deleted', { id: oldest.id });
          simCards = getSimCards();
        }
      }

      // Find or create next todo card
      var nextCard = simCards.find(function(c) { return c.column_name === 'todo'; });
      if (!nextCard) {
        var existing = simCards.map(function(c) { return c.title; });
        var available = SIM_IDEAS.filter(function(idea) {
          return existing.indexOf('[SIM] ' + idea.title) === -1;
        });
        if (available.length === 0) available = SIM_IDEAS.slice();
        var idea = available[Math.floor(Math.random() * available.length)];
        nextCard = createCard(idea, 'todo', 'queued');
        activity(nextCard.id, 'queue', 'Waiting in build queue...');
        await wait(3000);
        if (!simActive) break;
      }

      var cardId = nextCard.id;
      var ideaData = SIM_IDEAS.find(function(si) { return nextCard.title === '[SIM] ' + si.title; }) || { score: 7 };

      // === SNAPSHOT ===
      activity(cardId, 'snapshot', 'Taking file snapshot...');
      await wait(2000);
      if (!simActive) break;
      activity(cardId, 'snapshot', 'Snapshot taken (127 files)');
      await wait(1000);
      if (!simActive) break;

      // === BUILD ===
      cards.move(cardId, 'working');
      cards.setStatus(cardId, 'building');
      broadcast('card-updated', cards.get(cardId));

      var buildMsgs = ['CLAUDE.md written — launching Claude...', 'Reading codebase...', 'Planning implementation...', 'Writing code...', 'Installing dependencies...', 'Running tests...', 'All tests passing'];
      for (var bi = 0; bi < buildMsgs.length; bi++) {
        activity(cardId, 'build', buildMsgs[bi]);
        await wait(2000 + Math.floor(Math.random() * 3000));
        if (!simActive) break;
      }
      if (!simActive) break;

      // === REVIEW ===
      cards.move(cardId, 'review');
      cards.setStatus(cardId, 'reviewing');
      broadcast('card-updated', cards.get(cardId));

      activity(cardId, 'review', 'Starting code review...');
      await wait(3000);
      if (!simActive) break;
      activity(cardId, 'review', 'Analyzing code quality...');
      await wait(3000);
      if (!simActive) break;
      activity(cardId, 'review', 'Checking security patterns...');
      await wait(2000);
      if (!simActive) break;

      // Score — use idea's preset score (some are low = rejection)
      var score = ideaData.score;
      cards.setReviewData(cardId, score, '{}');
      broadcast('card-updated', cards.get(cardId));

      if (score < 5) {
        // === REJECTED — move back to todo like prod ===
        activity(cardId, 'review', 'Score ' + score + '/10 — rejected, needs rework');
        await wait(2000);
        if (!simActive) break;
        cards.move(cardId, 'todo');
        cards.setStatus(cardId, 'interrupted');
        activity(cardId, null, null);
        broadcast('card-updated', cards.get(cardId));
        broadcast('toast', { message: 'Rejected (' + score + '/10): ' + nextCard.title.replace('[SIM] ', ''), type: 'error' });
      } else if (score < 8) {
        // === AUTO-FIX then approve ===
        activity(cardId, 'fix', 'Score ' + score + '/10 — auto-fixing...');
        cards.setStatus(cardId, 'fixing');
        broadcast('card-updated', cards.get(cardId));
        await wait(5000);
        if (!simActive) break;
        activity(cardId, 'fix', 'Fix applied, re-reviewing...');
        await wait(3000);
        if (!simActive) break;

        var fixedScore = Math.min(10, score + 2);
        cards.setReviewData(cardId, fixedScore, '{}');
        activity(cardId, 'approve', 'Score ' + fixedScore + '/10 — auto-approving...');
        await wait(2000);
        if (!simActive) break;

        cards.move(cardId, 'done');
        cards.setStatus(cardId, 'complete');
        cards.setApprovedBy(cardId, 'ai');
        cards.setPhaseDurations(cardId, JSON.stringify({
          build: { duration: 15000 + Math.floor(Math.random() * 10000) },
          review: { duration: 8000 + Math.floor(Math.random() * 5000) },
          fix: { duration: 5000 },
        }));
        activity(cardId, null, null);
        broadcast('card-updated', cards.get(cardId));
        broadcast('toast', { message: 'Completed (fixed ' + score + '→' + fixedScore + '): ' + nextCard.title.replace('[SIM] ', ''), type: 'success' });
      } else {
        // === AUTO-APPROVE ===
        activity(cardId, 'approve', 'Score ' + score + '/10 — auto-approving...');
        await wait(1500);
        if (!simActive) break;
        activity(cardId, 'approve', 'Committing changes...');
        await wait(1500);
        if (!simActive) break;

        cards.move(cardId, 'done');
        cards.setStatus(cardId, 'complete');
        cards.setApprovedBy(cardId, 'ai');
        cards.setPhaseDurations(cardId, JSON.stringify({
          build: { duration: 15000 + Math.floor(Math.random() * 10000) },
          review: { duration: 8000 + Math.floor(Math.random() * 5000) },
        }));
        activity(cardId, null, null);
        broadcast('card-updated', cards.get(cardId));
        broadcast('toast', { message: 'Completed (' + score + '/10): ' + nextCard.title.replace('[SIM] ', ''), type: 'success' });
      }

      // Brief pause before next card (like prod pipeline)
      await wait(5000 + Math.floor(Math.random() * 5000));

    } catch (err) {
      if (simActive) log.error({ err: err.message }, 'Simulation loop error');
      await wait(10000);
    }
  }
}

// --- Restore on restart ---
function init() {
  try {
    if (dbConfig.get('simulation-mode') === 'true') {
      simActive = true;
      // Rebuild card ID list
      var allCards = cards.getAll();
      for (var i = 0; i < allCards.length; i++) {
        if (allCards[i].title && allCards[i].title.indexOf('[SIM]') === 0) {
          simCardIds.push(allCards[i].id);
          // Reset any mid-pipeline cards back to todo
          if (allCards[i].column_name === 'working' || allCards[i].column_name === 'review') {
            cards.move(allCards[i].id, 'todo');
            cards.setStatus(allCards[i].id, 'queued');
          }
        }
      }
      broadcast('simulation-state', { active: true });
      log.info({ cardCount: simCardIds.length }, 'Simulation restored');
      runLoop();
    }
  } catch (err) {
    log.error({ err: err.message }, 'Simulation restore failed');
  }
}

module.exports = {
  init: init,
  isSimActive: isSimActive,
  startSimulation: startSimulation,
  stopSimulation: stopSimulation,
  cleanupSimCards: cleanupSimCards,
};
