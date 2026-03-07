const fs = require('fs');
const path = require('path');
const { IS_WIN, RUNTIME_DIR, ROOT_DIR } = require('../config');
const { cards, sessions } = require('../db');
const { broadcast } = require('../lib/broadcast');
const { logPath, sendWebhook } = require('../lib/helpers');
const { runClaudeSilent } = require('./claude-runner');
const { getCustomPrompts } = require('./usage');

function buildBrainstormPrompt(card) {
  // Lazy require to avoid circular dep
  var support = require('./support');
  var isExisting = card.project_path && fs.existsSync(card.project_path);
  var parts = [];
  parts.push('You are a senior software architect working through a Kanban board system.');
  parts.push('Your job: analyze this task and produce a detailed, buildable specification.');
  parts.push('');

  if (isExisting) {
    parts.push('## Existing Project');
    parts.push(support.analyzeProject(card.project_path));
    parts.push('');
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
  }

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

  var cp = getCustomPrompts();
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

function brainstorm(cardId) {
  // Lazy require pipeline for setActivity, trackPhase, enqueue, buildPids
  var pipeline = require('./pipeline');

  var card = cards.get(cardId);
  if (!card) throw new Error('Card not found');

  cards.setStatus(cardId, 'brainstorming');
  broadcast('card-updated', cards.get(cardId));
  pipeline.setActivity(cardId, 'spec', 'Generating specification...');
  pipeline.trackPhase(cardId, 'brainstorm', 'start');

  var workDir = (card.project_path && fs.existsSync(card.project_path)) ? card.project_path : ROOT_DIR;
  var prompt = buildBrainstormPrompt(card);
  var outputFile = path.join(RUNTIME_DIR, '.brainstorm-output-' + cardId);
  var log = logPath(cardId, 'brainstorm');

  try { fs.unlinkSync(outputFile); } catch (_) {}

  var header = '[' + new Date().toISOString() + '] Brainstorm started\n'
    + 'Card: ' + card.title + '\nWorkDir: ' + workDir + '\n---\n';
  fs.writeFileSync(log, header);

  var run = runClaudeSilent({
    id: 'brainstorm-' + cardId,
    cardId: cardId,
    cwd: workDir,
    prompt: prompt,
    stdoutFile: outputFile,
    logFile: log,
  });

  pipeline.trackPid(cardId, run.pid);

  var session = sessions.create(cardId, 'brainstorm', run.pid);
  var sessionId = Number(session.lastInsertRowid);

  return new Promise(function(resolve) {
    var attempts = 0;
    var maxAttempts = 360;
    var lastMirroredSize = 0;

    var interval = setInterval(function() {
      attempts++;
      try {
        var cardNow = cards.get(cardId);
        if (!cardNow || cardNow.status !== 'brainstorming') {
          clearInterval(interval);
          return resolve({ success: false, reason: 'cancelled' });
        }

        // Mirror stdout to log on Windows (Linux uses tee)
        if (IS_WIN && fs.existsSync(outputFile)) {
          try {
            var outStat = fs.statSync(outputFile);
            if (outStat.size > lastMirroredSize) {
              var fd = fs.openSync(outputFile, 'r');
              var buf = Buffer.alloc(outStat.size - lastMirroredSize);
              fs.readSync(fd, buf, 0, buf.length, lastMirroredSize);
              fs.closeSync(fd);
              fs.appendFileSync(log, buf.toString('utf-8'));
              lastMirroredSize = outStat.size;
            }
          } catch (_) {}
        }

        if (fs.existsSync(outputFile)) {
          var content = fs.readFileSync(outputFile, 'utf-8').trim();
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
            try { fs.appendFileSync(log, '\n---\n[' + new Date().toISOString() + '] Brainstorm completed (' + content.length + ' chars)\n'); } catch (_) {}
            try { fs.unlinkSync(outputFile); } catch (_) {}
            try { fs.unlinkSync(run.scriptPath); } catch (_) {}

            // Auto-start work — zero-touch pipeline
            try {
              pipeline.setActivity(cardId, 'queue', 'Spec complete — auto-starting build...');
              pipeline.enqueue(cardId, 0);
              broadcast('toast', { message: 'Auto-starting build for: ' + cards.get(cardId).title, type: 'info' });
            } catch (autoErr) {
              console.error('Auto-start work failed for card', cardId, ':', autoErr.message);
              pipeline.clearActivity(cardId);
            }

            resolve({ success: true });
          }
        }

        if (attempts >= maxAttempts) {
          clearInterval(interval);
          pipeline.trackPhase(cardId, 'brainstorm', 'end');
          sessions.update(sessionId, 'failed', 'Timeout');
          cards.setStatus(cardId, 'idle');
          cards.setSessionLog(cardId, 'Brainstorm timed out after 30 minutes');
          pipeline.setActivity(cardId, 'spec', 'Timed out after 30 minutes');
          broadcast('card-updated', cards.get(cardId));
          try { fs.appendFileSync(log, '\n---\n[' + new Date().toISOString() + '] TIMEOUT\n'); } catch (_) {}
          resolve({ success: false, reason: 'timeout' });
        }
      } catch (_) {}
    }, 5000);
  });
}

module.exports = { brainstorm: brainstorm, buildBrainstormPrompt: buildBrainstormPrompt };
