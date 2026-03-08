const fs = require('fs');
const path = require('path');
const { runtime, RUNTIME_DIR, getEffectiveProjectPath } = require('../config');
const { cards, config: dbConfig } = require('../db');
const { broadcast } = require('../lib/broadcast');
const { log } = require('../lib/logger');
const { logPath, sendWebhook } = require('../lib/helpers');
const { runClaudeSilent } = require('./claude-runner');

// --- State ---
let discoveryInterval = null;
let discoveryRunning = false;
let lastDiscoveryAt = 0;
const pendingUserActions = []; // [{id, action, detail, blocking, createdAt}]
let pendingActionId = 0;

// --- Pending User Actions Queue ---
// When Claude needs something outside the project folder or a destructive action is flagged.

function addPendingAction(action, detail, blocking) {
  const entry = {
    id: ++pendingActionId,
    action: action,
    detail: detail,
    blocking: !!blocking,
    createdAt: Date.now(),
    resolved: false,
  };
  pendingUserActions.push(entry);
  broadcast('pending-action', entry);
  broadcast('toast', { message: 'Action required: ' + action, type: 'warning' });
  return entry;
}

function resolvePendingAction(id) {
  for (let i = 0; i < pendingUserActions.length; i++) {
    if (pendingUserActions[i].id === id) {
      pendingUserActions[i].resolved = true;
      broadcast('pending-action-resolved', { id: id });
      return true;
    }
  }
  return false;
}

function getPendingActions() {
  return pendingUserActions.filter(function(a) { return !a.resolved; });
}

// --- Project Analysis ---
// Reads the project and generates brainstorm ideas via Claude.

function isSingleProjectMode() {
  return runtime.mode === 'single-project';
}

function getProjectPath() {
  return getEffectiveProjectPath();
}

function countActiveBrainstorms() {
  const all = cards.getAll();
  let count = 0;
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (c.column_name === 'brainstorm' && c.deleted_at === null) count++;
  }
  return count;
}

function countActiveWork() {
  const all = cards.getAll();
  let count = 0;
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if ((c.column_name === 'working' || c.column_name === 'review' || c.column_name === 'todo') &&
        c.status !== 'idle' && c.status !== 'blocked') {
      count++;
    }
  }
  return count;
}

function hasActiveInitiativeWork() {
  // Check if any brainstorm card has incomplete children (an active initiative)
  const all = cards.getAll();
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (c.parent_card_id === null && c.spec && c.column_name !== 'done' && c.column_name !== 'archive') {
      const children = cards.getByParent(c.id);
      if (children.length > 0) {
        const incomplete = cards.countIncompleteChildren(c.id);
        if (incomplete > 0) return true;
      }
    }
  }
  return false;
}

function runDiscovery() {
  if (!isSingleProjectMode()) return;
  if (discoveryRunning) return;
  if (runtime.discoveryIntervalMins <= 0) return;

  const pipeline = require('./pipeline');
  if (pipeline.isPaused()) return;

  const projectPath = getProjectPath();
  if (!projectPath || !fs.existsSync(projectPath)) return;

  // Don't discover if there are any brainstorm cards pending
  if (countActiveBrainstorms() > 0) return;

  // Don't discover if there's active work (build/review/todo with status)
  if (countActiveWork() > 0) return;

  // Don't discover if there's an active initiative with incomplete children
  if (hasActiveInitiativeWork()) return;

  discoveryRunning = true;
  lastDiscoveryAt = Date.now();
  broadcast('discovery-state', { running: true });

  const outputFile = path.join(RUNTIME_DIR, '.discovery-output-' + Date.now());
  const log = path.join(RUNTIME_DIR, '.discovery-log-' + Date.now() + '.log');

  const header = '[' + new Date().toISOString() + '] Auto-discovery scan started\nProject: ' + projectPath + '\n---\n';
  fs.writeFileSync(log, header);

  // Build discovery prompt — reads the project and suggests improvements
  // Always discover exactly 1 idea — finish it end-to-end before the next
  const prompt = buildDiscoveryPrompt(projectPath, 1);

  const run = runClaudeSilent({
    id: 'discovery-' + Date.now(),
    cardId: 0,
    cwd: projectPath,
    prompt: prompt,
    stdoutFile: outputFile,
    logFile: log,
  });

  // Poll for discovery output
  let pollCount = 0;
  const maxPolls = 360; // 30 minutes

  const interval = setInterval(function() {
    pollCount++;
    try {
      if (fs.existsSync(outputFile)) {
        const content = fs.readFileSync(outputFile, 'utf-8').trim();
        if (content.length > 50) {
          clearInterval(interval);
          discoveryRunning = false;
          broadcast('discovery-state', { running: false });

          try {
            processDiscoveryOutput(content, projectPath);
          } catch (err) {
            log.error({ err: err.message }, 'Auto-discover failed to process output');
            try { fs.appendFileSync(log, '\n[ERROR] ' + err.message + '\n'); } catch (_) {}
          }

          try { fs.unlinkSync(outputFile); } catch (_) {}
          try { fs.unlinkSync(run.scriptPath); } catch (_) {}
        }
      }

      if (pollCount >= maxPolls) {
        clearInterval(interval);
        discoveryRunning = false;
        broadcast('discovery-state', { running: false });
        try { fs.appendFileSync(log, '\n[TIMEOUT] Discovery scan timed out\n'); } catch (_) {}
        try { fs.unlinkSync(outputFile); } catch (_) {}
      }
    } catch (err) {
      log.error({ err: err.message }, 'Auto-discover poll error');
    }
  }, 5000);
}

function captureOriginalIdea(projectPath) {
  if (dbConfig.get('original-idea')) return;
  const files = ['idea.md', 'IDEAS.md', 'ROADMAP.md', 'TODO.md', 'README.md'];
  const captured = [];
  for (let i = 0; i < files.length; i++) {
    const fp = path.join(projectPath, files[i]);
    if (fs.existsSync(fp)) {
      try {
        const limit = files[i] === 'README.md' ? 3000 : 5000;
        captured.push('--- ' + files[i] + ' ---\n' + fs.readFileSync(fp, 'utf-8').slice(0, limit));
      } catch (_) {}
    }
  }
  if (captured.length > 0) {
    dbConfig.set('original-idea', captured.join('\n\n'));
  }
}

function getCompletedWorkSummary() {
  const allCards = cards.getAll().concat(cards.getArchived());
  const completed = [];
  for (let i = 0; i < allCards.length; i++) {
    const c = allCards[i];
    if (c.column_name === 'done' || c.column_name === 'archive') {
      let entry = '- ' + c.title;
      if (c.review_score) entry += ' (score: ' + c.review_score + '/10)';
      if (c.labels) entry += ' [' + c.labels + ']';
      completed.push(entry);
    }
  }
  return completed;
}

function buildDiscoveryPrompt(projectPath) {
  // --- Alignment tracking ---
  const cycleCount = Number(dbConfig.get('brainstorm-cycle-count') || '0');
  const isRogueCycle = cycleCount > 0 && (cycleCount + 1) % 4 === 0;

  // Capture original idea on first run
  captureOriginalIdea(projectPath);
  const originalIdea = dbConfig.get('original-idea');

  // Completed work summary
  const completedWork = getCompletedWorkSummary();

  const parts = [];
  parts.push('You are an autonomous project analyst for a CI/CD kanban system.');

  if (isRogueCycle) {
    parts.push('');
    parts.push('## MODE: ROGUE INNOVATION (Cycle #' + (cycleCount + 1) + ')');
    parts.push('This is a special innovation cycle. Think laterally and suggest exactly 1 UNEXPECTED feature.');
    parts.push('Go beyond the original scope. Add functionality that seems unrelated but will prove useful in the future.');
    parts.push('Think cross-domain: what adjacent capability would make this project surprisingly more powerful?');
    parts.push('Examples: analytics dashboard for a CLI tool, plugin system for a monolith, AI-powered search for a CRUD app, WebSocket live-sync for a static site.');
    parts.push('The feature MUST be fully integrated with the existing codebase, not a disconnected experiment.');
  } else {
    parts.push('Your job: analyze this project thoroughly and suggest exactly 1 high-impact improvement.');
    parts.push('Stay tightly aligned with the project\'s original vision. Build on what exists, deepen it, strengthen it.');
  }
  parts.push('');

  // Original idea — north star
  if (originalIdea) {
    parts.push('## Original Project Vision (North Star)');
    if (isRogueCycle) {
      parts.push('The rogue feature should creatively complement this vision, not contradict it:');
    } else {
      parts.push('Every improvement must serve or extend this founding vision:');
    }
    parts.push(originalIdea);
    parts.push('');
  }

  // Completed work — prevent duplication
  if (completedWork.length > 0) {
    parts.push('## Already Completed (' + completedWork.length + ' items)');
    parts.push('Do NOT suggest anything that duplicates, undoes, or conflicts with this work:');
    parts.push(completedWork.join('\n'));
    parts.push('');
  }

  parts.push('## Project Location');
  parts.push(projectPath);
  parts.push('');

  parts.push('## Analysis Mandate');
  parts.push('Read the ENTIRE codebase first. Every source file, config, test, and script.');
  parts.push('Understand what the project does today before suggesting what it should do next.');
  parts.push('Your suggestion must integrate seamlessly with the existing architecture.');
  parts.push('');

  parts.push('## Analysis Checklist');
  parts.push('Check for:');
  parts.push('1. **Bugs**: Runtime errors, logic flaws, edge cases, null handling');
  parts.push('2. **Security**: OWASP Top 10, injection, XSS, auth flaws, secrets in code');
  parts.push('3. **Performance**: N+1 queries, missing caching, bundle size, lazy loading');
  parts.push('4. **Dependencies**: Outdated packages, known CVEs, missing lockfile integrity');
  parts.push('5. **Code quality**: Dead code, DRY violations, complexity, naming inconsistencies');
  parts.push('6. **UX improvements**: Accessibility (WCAG 2.2 AA), mobile responsiveness, error messages');
  parts.push('7. **Missing features**: Obvious gaps that would improve the user experience');
  parts.push('8. **Testing**: Missing test coverage, untested edge cases');
  parts.push('9. **Documentation**: README gaps, missing API docs, unclear setup instructions');
  parts.push('');

  // Check for idea.md or similar files
  const ideaFiles = ['idea.md', 'IDEAS.md', 'TODO.md', 'ROADMAP.md', '.github/ISSUES.md'];
  const foundIdeas = [];
  for (let i = 0; i < ideaFiles.length; i++) {
    const fp = path.join(projectPath, ideaFiles[i]);
    if (fs.existsSync(fp)) {
      foundIdeas.push(ideaFiles[i]);
    }
  }
  if (foundIdeas.length > 0) {
    parts.push('## Project Ideas Files Found');
    parts.push('Read these files for additional context on what the project needs:');
    for (let j = 0; j < foundIdeas.length; j++) {
      parts.push('- ' + foundIdeas[j]);
    }
    parts.push('');
  }

  parts.push('## Devil\'s Advocate');
  parts.push('For each suggestion, challenge yourself:');
  parts.push('- Is this actually needed, or just "nice to have"?');
  parts.push('- Will this improve the user\'s life, or just look cleaner to developers?');
  parts.push('- Is the timing right, or is this premature optimization?');
  parts.push('- What\'s the cost of NOT doing this?');
  if (isRogueCycle) {
    parts.push('- For rogue features: will this age well? Will users discover it and be delighted?');
  }
  parts.push('Only suggest things that pass this filter.');
  parts.push('');
  parts.push('## Output Format');
  parts.push('Output ONLY valid JSON (no markdown fences, no explanation before/after):');
  parts.push('[');
  parts.push('  {"title": "Short imperative title (max 80 chars)", "description": "2-3 sentence description of what needs to change and why", "labels": "bug|feature|security|perf|refactor|docs|chore", "priority": "critical|high|medium|low"}');
  parts.push(']');
  parts.push('');
  parts.push('Exactly 1 item — the single highest-impact improvement. It must be independently buildable as an end-to-end solution.');
  parts.push('You have full tool access — read files, search code, check dependencies. Be thorough.');

  return parts.join('\n');
}

function processDiscoveryOutput(content, projectPath) {
  // Try to parse JSON from the output (might have extra text around it)
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    log.error('Auto-discover: no JSON array found in output');
    return;
  }

  let ideas;
  try {
    ideas = JSON.parse(jsonMatch[0]);
  } catch (err) {
    log.error({ err: err.message }, 'Auto-discover JSON parse failed');
    return;
  }

  if (!Array.isArray(ideas) || ideas.length === 0) return;

  const brainstormSvc = require('./brainstorm');
  const pipeline = require('./pipeline');
  let created = 0;

  // Only create 1 card per discovery cycle — sequential pipeline
  for (let i = 0; i < ideas.length && i < 1; i++) {
    const idea = ideas[i];
    if (!idea.title) continue;

    // Check for duplicates — skip if a card with very similar title exists
    const existing = cards.search(idea.title.slice(0, 30));
    let isDuplicate = false;
    for (let e = 0; e < existing.length; e++) {
      if (existing[e].title.toLowerCase() === idea.title.toLowerCase()) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    // Create the brainstorm card
    const result = cards.create(idea.title, idea.description || '', 'brainstorm');
    const card = cards.get(Number(result.lastInsertRowid));
    if (!card) continue;

    cards.setProjectPath(card.id, projectPath);
    if (idea.labels) cards.setLabels(card.id, idea.labels);
    broadcast('card-created', cards.get(card.id));
    created++;

    // Auto-start brainstorm
    try {
      brainstormSvc.brainstorm(card.id);
    } catch (err) {
      log.error({ cardId: card.id, err: err.message }, 'Auto-discover brainstorm failed');
    }
  }

  if (created > 0) {
    const newCycle = Number(dbConfig.get('brainstorm-cycle-count') || '0') + 1;
    dbConfig.set('brainstorm-cycle-count', String(newCycle));
    const nextIsRogue = (newCycle + 1) % 4 === 0;
    log.info({ cycle: newCycle, nextRogue: nextIsRogue }, 'Brainstorm cycle #' + newCycle + ' started');
    broadcast('toast', { message: 'Auto-discovery: cycle #' + newCycle + (nextIsRogue ? ' (next: rogue innovation)' : ''), type: 'success' });
    sendWebhook('auto-discovery', { count: created, cycle: newCycle, ideas: ideas.slice(0, created).map(function(i) { return i.title; }) });
  }
}

// --- Lifecycle ---

function init() {
  if (!isSingleProjectMode()) return;
  if (runtime.discoveryIntervalMins <= 0) return;

  const projectPath = getProjectPath();
  if (projectPath) {
    log.info({ projectPath, interval: runtime.discoveryIntervalMins, autoPromote: runtime.autoPromoteBrainstorm }, 'Auto-discover: single-project mode');
  }

  // Initial discovery after a short delay (let server fully start)
  setTimeout(function() {
    runDiscovery();
  }, 10000);

  // Periodic discovery
  startPeriodicDiscovery();
}

function startPeriodicDiscovery() {
  stopPeriodicDiscovery();
  if (runtime.discoveryIntervalMins <= 0) return;
  discoveryInterval = setInterval(function() {
    runDiscovery();
  }, runtime.discoveryIntervalMins * 60 * 1000);
}

function stopPeriodicDiscovery() {
  if (discoveryInterval) {
    clearInterval(discoveryInterval);
    discoveryInterval = null;
  }
}

function getState() {
  return {
    mode: runtime.mode,
    singleProjectPath: getProjectPath(),
    discoveryRunning: discoveryRunning,
    lastDiscoveryAt: lastDiscoveryAt ? new Date(lastDiscoveryAt).toISOString() : null,
    autoPromoteBrainstorm: runtime.autoPromoteBrainstorm,
    maxBrainstormQueue: runtime.maxBrainstormQueue,
    discoveryIntervalMins: runtime.discoveryIntervalMins,
    maxChildCards: runtime.maxChildCards,
    pendingActions: getPendingActions().length,
    activeBrainstorms: countActiveBrainstorms(),
    hasActiveInitiative: hasActiveInitiativeWork(),
  };
}

module.exports = {
  init: init,
  runDiscovery: runDiscovery,
  startPeriodicDiscovery: startPeriodicDiscovery,
  stopPeriodicDiscovery: stopPeriodicDiscovery,
  getState: getState,
  isSingleProjectMode: isSingleProjectMode,
  getProjectPath: getProjectPath,
  addPendingAction: addPendingAction,
  resolvePendingAction: resolvePendingAction,
  getPendingActions: getPendingActions,
  hasActiveInitiativeWork: hasActiveInitiativeWork,
  countActiveBrainstorms: countActiveBrainstorms,
};
