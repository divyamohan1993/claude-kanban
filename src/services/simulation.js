/**
 * Simulation Mode — Showcases the Claude Kanban pipeline without using any AI tokens.
 * Creates realistic cards and moves them through the full pipeline with randomized timing.
 * Cards appear to be brainstormed, built, reviewed, fixed, and deployed — all simulated.
 */

const { cards, config: dbConfig } = require('../db');
const { broadcast } = require('../lib/broadcast');
const { log } = require('../lib/logger');
const { runtime } = require('../config');

// --- Simulation Data ---
// Realistic project improvement ideas across various categories

const SIM_IDEAS = [
  { title: 'Add dark mode toggle with system preference detection', description: 'Detect prefers-color-scheme and add a manual toggle that persists in localStorage.', labels: 'feature', score: 9 },
  { title: 'Fix XSS vulnerability in user comment rendering', description: 'Sanitize HTML in comment display to prevent stored XSS attacks via malicious input.', labels: 'security', score: 10 },
  { title: 'Implement lazy loading for dashboard images', description: 'Use Intersection Observer to defer offscreen image loading, reducing initial LCP by ~40%.', labels: 'perf', score: 8 },
  { title: 'Add keyboard navigation for data table', description: 'Arrow keys to navigate cells, Enter to edit, Escape to cancel. WCAG 2.2 AA compliance.', labels: 'feature', score: 9 },
  { title: 'Fix race condition in concurrent form submissions', description: 'Debounce submit handler and add optimistic locking to prevent duplicate entries.', labels: 'bug', score: 8 },
  { title: 'Refactor authentication middleware into composable guards', description: 'Split monolithic auth middleware into role-based, rate-limit, and session guards.', labels: 'refactor', score: 7 },
  { title: 'Add real-time WebSocket notifications', description: 'Replace polling with WebSocket for instant updates on card state changes and mentions.', labels: 'feature', score: 9 },
  { title: 'Implement CSP nonce-based script loading', description: 'Generate per-request nonces for inline scripts, eliminating unsafe-inline CSP directive.', labels: 'security', score: 10 },
  { title: 'Add search with fuzzy matching and filters', description: 'Implement Levenshtein-based fuzzy search with label, status, and date range filters.', labels: 'feature', score: 8 },
  { title: 'Fix memory leak in SSE connection handler', description: 'Properly clean up event listeners and buffers when SSE clients disconnect.', labels: 'bug', score: 9 },
  { title: 'Add responsive breakpoints for mobile layout', description: 'Redesign card grid to stack vertically on screens <768px with swipeable columns.', labels: 'feature', score: 8 },
  { title: 'Implement database connection pooling', description: 'Replace single connection with pool of 5, reducing p99 latency from 180ms to 45ms.', labels: 'perf', score: 9 },
  { title: 'Add automated backup verification', description: 'After each backup, restore to temp DB and validate row counts match source.', labels: 'chore', score: 7 },
  { title: 'Fix timezone handling in date displays', description: 'Convert all timestamps to user local timezone using Intl.DateTimeFormat API.', labels: 'bug', score: 8 },
  { title: 'Add rate limiting with sliding window algorithm', description: 'Replace fixed-window rate limiter with sliding window for smoother traffic handling.', labels: 'security', score: 9 },
  { title: 'Implement undo/redo for card edits', description: 'Command pattern with history stack supporting 50 undo levels per session.', labels: 'feature', score: 8 },
  { title: 'Add end-to-end encryption for sensitive fields', description: 'AES-256-GCM encryption for PII fields with per-tenant key rotation.', labels: 'security', score: 10 },
  { title: 'Optimize bundle size with tree shaking', description: 'Analyze and remove dead code paths, reducing JS payload from 340KB to 180KB gzipped.', labels: 'perf', score: 8 },
  { title: 'Add drag-and-drop file upload with preview', description: 'Dropzone with image preview, progress bar, and automatic format validation.', labels: 'feature', score: 7 },
  { title: 'Implement circuit breaker for external API calls', description: 'Add circuit breaker pattern with exponential backoff for third-party service calls.', labels: 'refactor', score: 9 },
];

const SIM_REVIEW_FINDINGS = [
  'Code follows single responsibility principle correctly',
  'Error handling is comprehensive with proper fallbacks',
  'SQL injection prevented via parameterized queries',
  'CSS follows BEM naming convention consistently',
  'Unit tests cover all edge cases including null inputs',
  'API response schema matches OpenAPI specification',
  'Accessibility audit passed: all interactive elements have labels',
  'Performance benchmark: p95 response time under 100ms',
  'Security headers properly configured (HSTS, CSP, X-Frame)',
  'Database migrations are reversible with rollback support',
];

const SIM_ACTIVITY_MESSAGES = {
  brainstorm: ['Analyzing codebase structure...', 'Identifying improvement opportunities...', 'Generating detailed specification...', 'Writing acceptance criteria...'],
  snapshot: ['Taking file snapshot...', 'Snapshot taken (127 files)'],
  build: ['CLAUDE.md written — launching Claude...', 'Claude is coding...', 'Installing dependencies...', 'Writing implementation...', 'Running tests...', 'All tests passing'],
  review: ['Starting code review...', 'Analyzing code quality...', 'Checking security patterns...', 'Review complete'],
  fix: ['Applying review fixes...', 'Fixing code style issues...', 'Fix applied, re-reviewing...'],
  approve: ['Score 9/10 — auto-approving...', 'Committing changes...', 'Push to remote complete'],
};

// --- Simulation State ---
let simActive = false;
let simTimers = [];     // all setTimeout handles for cleanup
let simCardIds = [];    // track created card IDs for cleanup

function isSimActive() { return simActive; }

function startSimulation() {
  if (simActive) return { error: 'Simulation already running' };
  simActive = true;
  simTimers = [];
  simCardIds = [];
  dbConfig.set('simulation-mode', 'true');

  // Skip any active demo timer so simulation cards appear instantly
  try {
    var pipeline = require('./pipeline');
    pipeline.skipDemoTimer();
  } catch (_) {}

  broadcast('simulation-state', { active: true });
  broadcast('demo-timer', { active: false, nextRunAt: 0, remaining: 0 });
  broadcast('toast', { message: 'Simulation started — watch the pipeline in action', type: 'success' });
  log.info('Simulation mode started');

  // Create initial batch of cards in various states to show a populated board
  seedInitialCards();

  // Start the autonomous simulation loop
  scheduleNextSimCard();

  return { active: true };
}

function stopSimulation() {
  simActive = false;
  dbConfig.set('simulation-mode', 'false');

  // Clear all timers
  for (var i = 0; i < simTimers.length; i++) {
    clearTimeout(simTimers[i]);
  }
  simTimers = [];

  // Auto-destroy all simulation cards on stop
  cleanupSimCards();

  broadcast('simulation-state', { active: false });
  broadcast('toast', { message: 'Simulation stopped — all sim cards removed', type: 'info' });
  log.info('Simulation mode stopped');

  return { active: false };
}

function cleanupSimCards() {
  // Delete all simulation cards
  for (var i = 0; i < simCardIds.length; i++) {
    try { cards.delete(simCardIds[i]); } catch (_) {}
  }
  simCardIds = [];
  broadcast('board-reload', {});
  broadcast('toast', { message: 'Simulation cards cleaned up', type: 'info' });
  return { cleaned: true };
}

// --- Seed Initial Cards ---
// Creates a spread of cards across all columns to show a fully populated board

function seedInitialCards() {
  var shuffled = SIM_IDEAS.slice().sort(function() { return Math.random() - 0.5; });
  var idx = 0;

  // 2 cards in todo (queued)
  for (var t = 0; t < 2 && idx < shuffled.length; t++, idx++) {
    var todoCard = createSimCard(shuffled[idx], 'todo', 'queued');
    simulateActivity(todoCard.id, 'queue', 'Waiting in build queue...');
  }

  // 1 card in working (building)
  if (idx < shuffled.length) {
    var workCard = createSimCard(shuffled[idx], 'working', 'building');
    idx++;
    simulateActivity(workCard.id, 'build', 'Claude is coding...');
    // Animate this card through build
    animateCard(workCard.id, 'build', 8000);
  }

  // 1 card in review
  if (idx < shuffled.length) {
    var revCard = createSimCard(shuffled[idx], 'review', 'reviewing');
    idx++;
    cards.setReviewData(revCard.id, shuffled[idx - 1].score || 8, '{}');
    simulateActivity(revCard.id, 'review', 'Analyzing code quality...');
    animateCard(revCard.id, 'review', 12000);
  }

  // 3 cards in done
  for (var d = 0; d < 3 && idx < shuffled.length; d++, idx++) {
    var doneCard = createSimCard(shuffled[idx], 'done', 'complete');
    cards.setReviewData(doneCard.id, shuffled[idx].score || 9, '{}');
    cards.setApprovedBy(doneCard.id, 'ai');
    // Set fake durations
    var durations = JSON.stringify({
      brainstorm: { start: Date.now() - 300000, end: Date.now() - 240000, duration: 60000 + Math.floor(Math.random() * 120000) },
      build: { start: Date.now() - 240000, end: Date.now() - 60000, duration: 120000 + Math.floor(Math.random() * 180000) },
      review: { start: Date.now() - 60000, end: Date.now() - 10000, duration: 30000 + Math.floor(Math.random() * 60000) },
    });
    cards.setPhaseDurations(doneCard.id, durations);
  }
}

function createSimCard(idea, column, status) {
  var result = cards.create('[SIM] ' + idea.title, idea.description || '', column);
  var id = Number(result.lastInsertRowid);
  simCardIds.push(id);
  cards.setStatus(id, status);
  if (idea.labels) cards.setLabels(id, idea.labels);
  cards.setProjectPath(id, '/sim/project');
  broadcast('card-created', cards.get(id));
  return cards.get(id);
}

function simulateActivity(cardId, step, detail) {
  broadcast('card-activity', { cardId: cardId, step: step, detail: detail, timestamp: Date.now() });
}

// --- Card Animation ---
// Moves a card through pipeline steps with realistic timing

function animateCard(cardId, startPhase, delayMs) {
  if (!simActive) return;

  var phases = [];
  if (startPhase === 'build') {
    phases = [
      { delay: delayMs, step: 'build', msgs: SIM_ACTIVITY_MESSAGES.build },
      { delay: delayMs + 15000, action: 'move-to-review' },
      { delay: delayMs + 18000, step: 'review', msgs: SIM_ACTIVITY_MESSAGES.review },
      { delay: delayMs + 28000, action: 'complete' },
    ];
  } else if (startPhase === 'review') {
    phases = [
      { delay: delayMs, step: 'review', msgs: SIM_ACTIVITY_MESSAGES.review },
      { delay: delayMs + 10000, action: 'complete' },
    ];
  } else if (startPhase === 'full') {
    phases = [
      { delay: 0, step: 'snapshot', msgs: SIM_ACTIVITY_MESSAGES.snapshot },
      { delay: 3000, step: 'build', msgs: SIM_ACTIVITY_MESSAGES.build },
      { delay: 20000, action: 'move-to-review' },
      { delay: 23000, step: 'review', msgs: SIM_ACTIVITY_MESSAGES.review },
      { delay: 33000, action: 'score' },
      { delay: 36000, action: 'complete' },
    ];
  }

  for (var i = 0; i < phases.length; i++) {
    (function(phase) {
      var t = setTimeout(function() {
        if (!simActive) return;
        var card = cards.get(cardId);
        if (!card) return;

        if (phase.msgs) {
          // Cycle through activity messages
          var msg = phase.msgs[Math.floor(Math.random() * phase.msgs.length)];
          simulateActivity(cardId, phase.step, msg);
        }

        if (phase.action === 'move-to-review') {
          cards.move(cardId, 'review');
          cards.setStatus(cardId, 'reviewing');
          var idea = SIM_IDEAS[Math.floor(Math.random() * SIM_IDEAS.length)];
          cards.setReviewData(cardId, idea.score || 8, '{}');
          broadcast('card-updated', cards.get(cardId));
        } else if (phase.action === 'score') {
          var sc = 7 + Math.floor(Math.random() * 3); // 7-9
          cards.setReviewData(cardId, sc, '{}');
          broadcast('card-updated', cards.get(cardId));
        } else if (phase.action === 'complete') {
          cards.move(cardId, 'done');
          cards.setStatus(cardId, 'complete');
          cards.setApprovedBy(cardId, 'ai');
          simulateActivity(cardId, null, null);
          broadcast('card-updated', cards.get(cardId));
          broadcast('toast', { message: 'Completed: ' + card.title.replace('[SIM] ', ''), type: 'success' });
          // Schedule next card
          scheduleNextSimCard();
        }
      }, phase.delay + delayMs);
      simTimers.push(t);
    })(phases[i]);
  }
}

// --- Autonomous Loop ---
// Continuously creates new cards and animates them through the pipeline

function scheduleNextSimCard() {
  if (!simActive) return;

  // Random delay 15-40 seconds between new cards
  var delay = 15000 + Math.floor(Math.random() * 25000);

  var t = setTimeout(function() {
    if (!simActive) return;

    // Pick a random idea that isn't already on the board
    var existing = cards.getAll().map(function(c) { return c.title; });
    var available = SIM_IDEAS.filter(function(idea) {
      return existing.indexOf('[SIM] ' + idea.title) === -1;
    });

    if (available.length === 0) {
      // All ideas used — recycle by removing oldest done card
      var doneCards = cards.getAll().filter(function(c) {
        return c.column_name === 'done' && c.title.indexOf('[SIM]') === 0;
      });
      if (doneCards.length > 2) {
        var oldest = doneCards[doneCards.length - 1];
        cards.delete(oldest.id);
        broadcast('card-deleted', { id: oldest.id });
      }
      available = SIM_IDEAS.slice();
    }

    var idea = available[Math.floor(Math.random() * available.length)];

    // Create in todo, then animate through full pipeline
    var card = createSimCard(idea, 'todo', 'queued');
    simulateActivity(card.id, 'queue', 'Waiting in build queue...');

    // After a brief queue wait, start building
    var buildDelay = 3000 + Math.floor(Math.random() * 5000);
    var t2 = setTimeout(function() {
      if (!simActive) return;
      cards.move(card.id, 'working');
      cards.setStatus(card.id, 'building');
      broadcast('card-updated', cards.get(card.id));
      animateCard(card.id, 'full', 0);
    }, buildDelay);
    simTimers.push(t2);

    // Schedule the next one
    scheduleNextSimCard();
  }, delay);
  simTimers.push(t);
}

module.exports = {
  isSimActive: isSimActive,
  startSimulation: startSimulation,
  stopSimulation: stopSimulation,
  cleanupSimCards: cleanupSimCards,
};
