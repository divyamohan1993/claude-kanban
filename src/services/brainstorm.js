const fs = require('fs');
const path = require('path');
const { IS_WIN, RUNTIME_DIR, ROOT_DIR, runtime, getEffectiveProjectPath } = require('../config');
const { cards, sessions, config: dbConfig } = require('../db');
const { broadcast } = require('../lib/broadcast');
const { log } = require('../lib/logger');
const { logPath, sendWebhook } = require('../lib/helpers');
const { runClaudeSilent, detectRateLimit } = require('./claude-runner');
const { getCustomPrompts } = require('./usage');
const specIntel = require('./spec-intelligence');

// --- Brainstorm Queue (concurrency control) ---
let brainstormQueue = [];    // [{cardId, enqueuedAt}]
let activeBrainstorms = 0;   // count of running brainstorms

function buildBrainstormPrompt(card) {
  // Lazy require to avoid circular dep
  const support = require('./support');
  const isExisting = card.project_path && fs.existsSync(card.project_path);
  const parts = [];
  parts.push('You are a senior software architect working through a Kanban board system.');
  parts.push('Your job: analyze this task and produce a detailed, buildable specification.');
  parts.push('');

  // --- Multi-Lens Brainstorm: forces multi-perspective thinking before spec ---
  const multiLens = specIntel.buildMultiLensSection(card);
  if (multiLens) parts.push(multiLens);

  if (isExisting) {
    parts.push('## Existing Project');
    parts.push(support.analyzeProject(card.project_path));
    parts.push('');

    // Single-project alignment: north star + completed work + deep read
    if (runtime.mode === 'single-project') {
      // Capture original idea if not yet stored
      if (!dbConfig.get('original-idea')) {
        const ideaFiles = ['idea.md', 'IDEAS.md', 'ROADMAP.md', 'TODO.md', 'README.md'];
        const captured = [];
        for (let fi = 0; fi < ideaFiles.length; fi++) {
          const fp = path.join(card.project_path, ideaFiles[fi]);
          if (fs.existsSync(fp)) {
            try {
              const limit = ideaFiles[fi] === 'README.md' ? 3000 : 5000;
              captured.push('--- ' + ideaFiles[fi] + ' ---\n' + fs.readFileSync(fp, 'utf-8').slice(0, limit));
            } catch (_) {}
          }
        }
        if (captured.length > 0) {
          dbConfig.set('original-idea', captured.join('\n\n'));
        }
      }

      const originalIdea = dbConfig.get('original-idea');
      if (originalIdea) {
        parts.push('## Project Vision (North Star)');
        parts.push('This specification MUST advance the original project vision. Do not drift or go vague:');
        parts.push(originalIdea);
        parts.push('');
      }

      // SQL query — indexed, avoids loading all card data just for titles
      const completedRows = cards.getCompletedTitles(card.id);
      const completed = [];
      for (let di = 0; di < completedRows.length; di++) {
        completed.push('- ' + completedRows[di].title);
      }
      if (completed.length > 0) {
        parts.push('## Previously Completed Work');
        parts.push('Build on this existing work. Do not duplicate or contradict:');
        parts.push(completed.join('\n'));
        parts.push('');
      }

      parts.push('## Codebase Deep Read');
      parts.push('MANDATORY: Read the ENTIRE codebase before writing this specification.');
      parts.push('Understand every file, module, and pattern. Your spec must integrate seamlessly with the existing architecture.');
      parts.push('The codebase has grown from previous brainstorm cycles. Account for everything that exists now.');
      parts.push('');
    }

    // --- Historical Review Injection: past build intelligence ---
    const historical = specIntel.gatherHistoricalContext(card);
    if (historical) parts.push(historical);

    parts.push('## Requested Changes');
    parts.push(card.title);
    if (card.description) parts.push(card.description);
    parts.push('');
    parts.push('Create a specification for these changes. Include:');
    parts.push('1) What exists now (brief summary)');
    parts.push('2) What needs to change and why');
    parts.push('3) Files to modify/create with specific changes');
    parts.push('4) Step-by-step implementation plan');
    parts.push('5) Risks, edge cases, and rollback considerations');
  } else {
    parts.push('## New Project');
    parts.push('Project: ' + card.title);
    if (card.description) parts.push('Details: ' + card.description);
    parts.push('');
    parts.push('Create a full technical specification. Include:');
    parts.push('1) Project Overview — what it does, for whom, why it matters');
    parts.push('2) Core Features (MVP only)');
    parts.push('3) Tech Stack with justification');
    parts.push('4) Architecture and data flow');
    parts.push('5) File structure');
    parts.push('6) Step-by-step implementation plan');
    parts.push('7) Edge cases and risks');

    // --- Historical Review Injection for new projects ---
    const historicalNew = specIntel.gatherHistoricalContext(card);
    if (historicalNew) parts.push(historicalNew);
  }

  // --- Domain Coverage: steers spec toward neglected product areas ---
  const domainCoverage = specIntel.buildDomainCoverageSection();
  if (domainCoverage) parts.push(domainCoverage);

  // --- Creative Constraint: randomized creative thinking prompt ---
  const constraint = specIntel.selectCreativeConstraint(card);
  if (constraint) parts.push(constraint);

  // --- Confrontational Challenges: forces real critical thinking ---
  const confrontational = specIntel.buildConfrontationalSection();
  if (confrontational) parts.push(confrontational);

  parts.push('');
  parts.push('Be practical and specific. This spec will be given to an AI coding agent (Claude Code)');
  parts.push('that will build it autonomously. Make every instruction actionable.');
  parts.push('');
  parts.push('## Quality Gates (enforce these in the spec)');
  parts.push('- pnpm only (never npm/yarn)');
  parts.push('- YAGNI, DRY, KISS — no over-engineering, no premature abstraction');
  parts.push('- Security: zero trust, all input hostile, OWASP Top 10, parameterized queries, no innerHTML');
  parts.push('- Accessibility: WCAG 2.2 AA, semantic HTML, keyboard navigation, ARIA labels');
  parts.push('- Performance: cache-first, lazy loading, bundle < 200KB gzip');
  parts.push('- Frontend: distinctive UI — skeuomorphic depth, micro-interactions, never generic templates');
  parts.push('- Naming: files kebab-case, components PascalCase, vars camelCase, constants UPPER_SNAKE_CASE');
  parts.push('- Servers must use random high ports (49152-65535), never common ports (3000, 8080, etc.)');
  parts.push("- Complete or don't ship — every feature must work end-to-end, no TODOs in user-facing paths");
  parts.push('');
  parts.push('You have full access to all tools — read files, search code, explore the project. Use them to understand the codebase deeply before writing the spec.');
  parts.push('Output the complete specification as your final response text.');

  const cp = getCustomPrompts();
  if (cp.brainstormInstructions) {
    parts.push('');
    parts.push('## Additional Brainstorm Instructions');
    parts.push(cp.brainstormInstructions);
  }
  if (cp.qualityGates) {
    parts.push('');
    parts.push('## Additional Quality Gates');
    parts.push(cp.qualityGates);
  }

  return parts.join('\n');
}

function processBrainstormQueue() {
  const pipeline = require('./pipeline');
  if (pipeline.isPaused()) return;
  if (activeBrainstorms >= runtime.maxConcurrentBuilds) return;
  if (brainstormQueue.length === 0) return;

  const next = brainstormQueue.shift();
  const card = cards.get(next.cardId);
  if (!card || card.status !== 'brainstorm-queued') {
    processBrainstormQueue();
    return;
  }

  executeBrainstorm(next.cardId);
}

// Pre-check: is brainstorming allowed? (Single-project mode enforces one at a time)
function canBrainstorm(cardId) {
  if (runtime.mode !== 'single-project') return { allowed: true };

  // Single pass over all cards — checks brainstorm conflicts, initiatives, and orphaned children
  const allCards = cards.getAll();
  for (let i = 0; i < allCards.length; i++) {
    const c = allCards[i];
    if (c.id === cardId) continue;

    // Block if another brainstorm is actively running
    if (c.status === 'brainstorming' || c.status === 'brainstorm-queued') {
      return { allowed: false, reason: 'Another brainstorm is running: "' + c.title + '". Wait for it to finish.' };
    }

    // Block if an initiative has incomplete children
    if (c.status === 'initiative-active') {
      const incomplete = cards.countIncompleteChildren(c.id);
      if (incomplete > 0) {
        return {
          allowed: false,
          reason: 'Initiative "' + c.title + '" has ' + incomplete + ' incomplete task(s). Complete them first so the next brainstorm sees the latest codebase.',
        };
      }
    }

    // Check for orphaned in-progress child cards
    if (c.parent_card_id && c.column_name !== 'done' && c.column_name !== 'archive') {
      return {
        allowed: false,
        reason: 'Sub-task "' + c.title + '" is still in progress. Complete all tasks before starting a new brainstorm.',
      };
    }
  }

  return { allowed: true };
}

function brainstorm(cardId) {
  const pipeline = require('./pipeline');

  const card = cards.get(cardId);
  if (!card) throw new Error('Card not found');

  // Check if already brainstorming or queued
  if (card.status === 'brainstorming' || card.status === 'brainstorm-queued') {
    return Promise.resolve({ success: false, reason: 'already in progress' });
  }

  // Single-project mode: enforce one brainstorm at a time
  const check = canBrainstorm(cardId);
  if (!check.allowed) {
    return Promise.resolve({ success: false, reason: check.reason });
  }

  // Check concurrency — queue if at limit
  if (activeBrainstorms >= runtime.maxConcurrentBuilds) {
    cards.setStatus(cardId, 'brainstorm-queued');
    pipeline.setActivity(cardId, 'spec', 'Queued for brainstorm (' + (brainstormQueue.length + 1) + ' in line)...');
    broadcast('card-updated', cards.get(cardId));
    brainstormQueue.push({ cardId: cardId, enqueuedAt: Date.now() });
    return Promise.resolve({ success: true, queued: true, position: brainstormQueue.length });
  }

  return executeBrainstorm(cardId);
}

function executeBrainstorm(cardId) {
  // Lazy require pipeline for setActivity, trackPhase, enqueue, buildPids
  const pipeline = require('./pipeline');

  const card = cards.get(cardId);
  if (!card) throw new Error('Card not found');

  activeBrainstorms++;
  cards.setStatus(cardId, 'brainstorming');
  broadcast('card-updated', cards.get(cardId));
  pipeline.setActivity(cardId, 'spec', 'Generating specification...');
  pipeline.trackPhase(cardId, 'brainstorm', 'start');

  const workDir = (card.project_path && fs.existsSync(card.project_path)) ? card.project_path : ROOT_DIR;
  const prompt = buildBrainstormPrompt(card);
  const outputFile = path.join(RUNTIME_DIR, '.brainstorm-output-' + cardId);
  const bsLogFile = logPath(cardId, 'brainstorm');

  try { fs.unlinkSync(outputFile); } catch (_) {}

  const header = '[' + new Date().toISOString() + '] Brainstorm started\n'
    + 'Card: ' + card.title + '\nWorkDir: ' + workDir + '\n---\n';
  fs.writeFileSync(bsLogFile, header);

  const run = runClaudeSilent({
    id: 'brainstorm-' + cardId,
    cardId: cardId,
    cwd: workDir,
    prompt: prompt,
    stdoutFile: outputFile,
    logFile: bsLogFile,
  });

  pipeline.trackPid(cardId, run.pid);

  const session = sessions.create(cardId, 'brainstorm', run.pid);
  const sessionId = Number(session.lastInsertRowid);

  return new Promise(function(resolve) {
    let attempts = 0;
    const maxAttempts = Math.round(runtime.brainstormTimeoutMins * 60000 / runtime.pollIntervalMs);
    let lastMirroredSize = 0;

    const interval = setInterval(function() {
      attempts++;
      try {
        const cardNow = cards.get(cardId);
        if (!cardNow || cardNow.status !== 'brainstorming') {
          clearInterval(interval);
          activeBrainstorms = Math.max(0, activeBrainstorms - 1);
          processBrainstormQueue();
          return resolve({ success: false, reason: 'cancelled' });
        }

        // Mirror stdout to log on Windows (Linux uses tee)
        if (IS_WIN && fs.existsSync(outputFile)) {
          try {
            const outStat = fs.statSync(outputFile);
            if (outStat.size > lastMirroredSize) {
              const fd = fs.openSync(outputFile, 'r');
              const buf = Buffer.alloc(outStat.size - lastMirroredSize);
              fs.readSync(fd, buf, 0, buf.length, lastMirroredSize);
              fs.closeSync(fd);
              fs.appendFileSync(bsLogFile, buf.toString('utf-8'));
              lastMirroredSize = outStat.size;
            }
          } catch (_) {}
        }

        if (fs.existsSync(outputFile)) {
          const content = fs.readFileSync(outputFile, 'utf-8').trim();
          if (content.length > 50) {
            clearInterval(interval);
            pipeline.trackPhase(cardId, 'brainstorm', 'end');
            sessions.update(sessionId, 'completed', content);
            cards.setSpec(cardId, content);
            cards.setStatus(cardId, 'idle');
            cards.move(cardId, 'todo');
            pipeline.setActivity(cardId, 'spec', 'Spec ready (' + Math.round(content.length / 1024) + ' KB)');
            broadcast('card-updated', cards.get(cardId));
            sendWebhook('brainstorm-complete', { cardId: cardId, title: card.title, specLength: content.length });
            try { fs.appendFileSync(bsLogFile, '\n---\n[' + new Date().toISOString() + '] Brainstorm completed (' + content.length + ' chars)\n'); } catch (_) {}
            try { fs.unlinkSync(outputFile); } catch (_) {}
            try { fs.unlinkSync(run.scriptPath); } catch (_) {}

            activeBrainstorms = Math.max(0, activeBrainstorms - 1);

            // Single-project mode: decompose spec into child tasks or hold for manual approval
            if (runtime.mode === 'single-project') {
              if (runtime.autoPromoteBrainstorm) {
                // Fully autonomous: decompose and auto-queue
                pipeline.setActivity(cardId, 'decompose', 'Decomposing spec into tasks...');
                decomposeSpec(cardId).then(function() {
                  processBrainstormQueue();
                }).catch(function(err) {
                  log.error({ cardId, err: err.message }, 'decomposeSpec failed');
                  pipeline.clearActivity(cardId);
                  processBrainstormQueue();
                });
              } else {
                // Manual approval: brainstorm stays, user promotes to todo
                pipeline.setActivity(cardId, 'spec', 'Spec ready — awaiting manual approval to promote');
                broadcast('toast', { message: 'Brainstorm complete: ' + cards.get(cardId).title + ' — approve to start work', type: 'info' });
                processBrainstormQueue();
              }
            } else {
              // Global mode: auto-start work or hold for spec approval
              if (runtime.specApprovalGate) {
                // Spec approval gate: hold for human approval before building
                cards.setStatus(cardId, 'spec-ready');
                cards.move(cardId, 'brainstorm');
                pipeline.setActivity(cardId, 'spec', 'Spec ready — awaiting approval');
                broadcast('card-updated', cards.get(cardId));
                broadcast('toast', { message: 'Spec ready for approval: ' + cards.get(cardId).title, type: 'info' });
              } else {
                // Auto-start work
                try {
                  pipeline.setActivity(cardId, 'queue', 'Spec complete — auto-starting build...');
                  pipeline.enqueue(cardId, 0);
                  broadcast('toast', { message: 'Auto-starting build for: ' + cards.get(cardId).title, type: 'info' });
                } catch (autoErr) {
                  log.error({ cardId, err: autoErr.message }, 'Auto-start work failed');
                  pipeline.clearActivity(cardId);
                }
              }
              processBrainstormQueue();
            }

            resolve({ success: true });
          }
        }

        // Rate-limit fast-fail: check log for rate-limit errors
        if (attempts >= runtime.rateLimitMinPolls && attempts % 3 === 0) {
          const rl = detectRateLimit(bsLogFile);
          if (rl.detected) {
            clearInterval(interval);
            activeBrainstorms = Math.max(0, activeBrainstorms - 1);
            pipeline.trackPhase(cardId, 'brainstorm', 'end');
            sessions.update(sessionId, 'failed', 'Rate limited');
            pipeline.handleRateLimitDetected(cardId, 'brainstorm', bsLogFile);
            try { fs.unlinkSync(outputFile); } catch (_) {}
            processBrainstormQueue();
            return resolve({ success: false, reason: 'rate-limited' });
          }
        }

        if (attempts >= maxAttempts) {
          clearInterval(interval);
          activeBrainstorms = Math.max(0, activeBrainstorms - 1);
          pipeline.trackPhase(cardId, 'brainstorm', 'end');
          sessions.update(sessionId, 'failed', 'Timeout');
          cards.setStatus(cardId, 'idle');
          cards.setSessionLog(cardId, 'Brainstorm timed out after 30 minutes');
          pipeline.setActivity(cardId, 'spec', 'Timed out after 30 minutes');
          broadcast('card-updated', cards.get(cardId));
          try { fs.appendFileSync(bsLogFile, '\n---\n[' + new Date().toISOString() + '] TIMEOUT\n'); } catch (_) {}
          processBrainstormQueue();
          resolve({ success: false, reason: 'timeout' });
        }
      } catch (_) {}
    }, runtime.pollIntervalMs);
  });
}

// --- Decompose Spec into Child Todo Cards (Single-Project Mode) ---
// Takes a brainstorm card with a spec and spawns Claude to break it into actionable child tasks.

function decomposeSpec(parentCardId) {
  const pipeline = require('./pipeline');
  const parentCard = cards.get(parentCardId);
  if (!parentCard || !parentCard.spec) return Promise.resolve();

  const projectPath = parentCard.project_path || getEffectiveProjectPath();
  if (!projectPath) return Promise.resolve();

  const outputFile = path.join(RUNTIME_DIR, '.decompose-output-' + parentCardId);
  const dcLogFile = path.join(RUNTIME_DIR, '.decompose-log-' + parentCardId + '.log');

  try { fs.unlinkSync(outputFile); } catch (_) {}

  const header = '[' + new Date().toISOString() + '] Decomposing spec for card #' + parentCardId + '\n---\n';
  fs.writeFileSync(dcLogFile, header);

  const prompt = [
    'You are a task decomposition agent. Break this specification into concrete, independently buildable implementation tasks.',
    '',
    '## Specification',
    parentCard.spec,
    '',
    '## Rules',
    '- Each task must be independently buildable and testable',
    '- Tasks should be ordered by dependency (first task has no deps)',
    '- Each task works towards the end-to-end solution described in the spec',
    '- Maximum ' + runtime.maxChildCards + ' tasks',
    '- Each task title should be a clear imperative (e.g., "Add user authentication endpoint")',
    '- Mark interdependencies: a task can depend on previous tasks by index (0-based)',
    '',
    '## Devil\'s Advocate',
    '- Is each task truly necessary, or can two be merged?',
    '- Does each task deliver standalone value, or is it just a step?',
    '- Are you over-decomposing? 3 solid tasks beat 10 tiny ones.',
    '',
    '## Output Format',
    'Output ONLY valid JSON (no markdown fences):',
    '[{"title": "Task title", "description": "What to build and how", "depends_on_index": null or number}]',
    '',
    'Order matters: task 0 runs first, task 1 can depend on 0, etc.',
  ].join('\n');

  const run = runClaudeSilent({
    id: 'decompose-' + parentCardId,
    cardId: parentCardId,
    cwd: projectPath,
    prompt: prompt,
    stdoutFile: outputFile,
    logFile: dcLogFile,
  });

  return new Promise(function(resolve) {
    let pollCount = 0;
    const maxPolls = Math.round(runtime.decomposeTimeoutMins * 60000 / runtime.pollIntervalMs);

    const interval = setInterval(function() {
      pollCount++;
      try {
        if (fs.existsSync(outputFile)) {
          const content = fs.readFileSync(outputFile, 'utf-8').trim();
          if (content.length > 20) {
            clearInterval(interval);
            try {
              createChildCards(parentCardId, content, projectPath);
            } catch (err) {
              log.error({ parentCardId, err: err.message }, 'Decompose failed');
              // Fallback: treat the brainstorm card itself as the single task
              cards.move(parentCardId, 'todo');
              pipeline.setActivity(parentCardId, 'queue', 'Decompose failed — using spec directly');
              try { pipeline.enqueue(parentCardId, 0); } catch (_) {}
            }
            try { fs.unlinkSync(outputFile); } catch (_) {}
            try { fs.unlinkSync(run.scriptPath); } catch (_) {}
            resolve();
          }
        }
        // Rate-limit fast-fail for decompose
        if (pollCount >= runtime.rateLimitMinPolls && pollCount % 3 === 0) {
          const rl = detectRateLimit(dcLogFile);
          if (rl.detected) {
            clearInterval(interval);
            pipeline.handleRateLimitDetected(parentCardId, 'decompose', dcLogFile);
            try { fs.unlinkSync(outputFile); } catch (_) {}
            return resolve();
          }
        }

        if (pollCount >= maxPolls) {
          clearInterval(interval);
          log.error({ parentCardId }, 'Decompose timeout');
          // Fallback: use spec directly
          cards.move(parentCardId, 'todo');
          try { pipeline.enqueue(parentCardId, 0); } catch (_) {}
          resolve();
        }
      } catch (err) {
        log.error({ err: err.message }, 'Decompose poll error');
      }
    }, runtime.pollIntervalMs);
  });
}

function createChildCards(parentCardId, rawOutput, projectPath) {
  const pipeline = require('./pipeline');
  const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in decompose output');

  let tasks = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Empty task list');

  // Cap at maxChildCards
  tasks = tasks.slice(0, runtime.maxChildCards);

  const childIds = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (!task.title) continue;

    const result = cards.create(task.title, task.description || '', 'todo');
    const childCard = cards.get(Number(result.lastInsertRowid));
    if (!childCard) continue;

    cards.setParentCardId(childCard.id, parentCardId);
    cards.setProjectPath(childCard.id, projectPath);
    cards.setSpec(childCard.id, task.description || task.title);

    // Set dependencies — map index-based deps to actual card IDs
    const depIdx = task.depends_on_index;
    if (depIdx !== null && depIdx !== undefined && Number.isInteger(depIdx) && depIdx >= 0 && depIdx < childIds.length && childIds[depIdx]) {
      cards.setDependsOn(childCard.id, String(childIds[depIdx]));
    }

    childIds.push(childCard.id);
    broadcast('card-created', cards.get(childCard.id));
  }

  // Mark parent as "initiative active" — stays in brainstorm with children tracked
  cards.setStatus(parentCardId, 'initiative-active');
  pipeline.setActivity(parentCardId, 'decompose', 'Decomposed into ' + childIds.length + ' tasks');
  broadcast('card-updated', cards.get(parentCardId));
  broadcast('toast', { message: 'Decomposed "' + cards.get(parentCardId).title + '" into ' + childIds.length + ' tasks', type: 'success' });

  // Auto-enqueue the first child (others wait on dependencies)
  if (childIds.length > 0) {
    try {
      pipeline.enqueue(childIds[0], 0);
    } catch (err) {
      log.error({ err: err.message }, 'Decompose enqueue first child failed');
    }
  }

  return childIds;
}

// Manual promote — user approves a brainstorm card to start working
function promoteToTodo(cardId) {
  const pipeline = require('./pipeline');
  const card = cards.get(cardId);
  if (!card) throw new Error('Card not found');
  if (!card.spec) throw new Error('No spec — brainstorm not complete');
  if (card.column_name !== 'brainstorm') throw new Error('Card is not in brainstorm column');

  if (runtime.mode === 'single-project') {
    // Decompose and auto-queue
    pipeline.setActivity(cardId, 'decompose', 'Approved — decomposing spec into tasks...');
    broadcast('card-updated', cards.get(cardId));
    return decomposeSpec(cardId);
  } else {
    // Global mode: just move to todo and enqueue
    cards.move(cardId, 'todo');
    broadcast('card-updated', cards.get(cardId));
    return Promise.resolve(pipeline.enqueue(cardId, 1));
  }
}

function getActiveBrainstorms() { return activeBrainstorms; }
function getBrainstormQueue() { return brainstormQueue.map(function(q) { return q.cardId; }); }
function resetBrainstormState() { activeBrainstorms = 0; brainstormQueue = []; }

module.exports = {
  brainstorm: brainstorm,
  canBrainstorm: canBrainstorm,
  buildBrainstormPrompt: buildBrainstormPrompt,
  processBrainstormQueue: processBrainstormQueue,
  getActiveBrainstorms: getActiveBrainstorms,
  getBrainstormQueue: getBrainstormQueue,
  resetBrainstormState: resetBrainstormState,
  decomposeSpec: decomposeSpec,
  promoteToTodo: promoteToTodo,
};
