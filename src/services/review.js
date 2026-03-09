const fs = require('fs');
const path = require('path');
const { runtime } = require('../config');
const { cards } = require('../db');
const { broadcast } = require('../lib/broadcast');
const { log } = require('../lib/logger');
const snapshot = require('./snapshot');
const { logPath, sendWebhook } = require('../lib/helpers');
const { runClaudeSilent, detectRateLimit } = require('./claude-runner');
const { getCustomPrompts } = require('./usage');
const git = require('./git');

function autoReview(cardId) {
  // Lazy require pipeline to avoid circular dep
  const pipeline = require('./pipeline');

  const card = cards.get(cardId);
  if (!card || !card.project_path) {
    log.error({ cardId }, 'autoReview: card not found or no project_path');
    return;
  }

  const projectPath = card.project_path;
  if (!fs.existsSync(projectPath)) {
    log.error({ cardId, projectPath }, 'autoReview: project path does not exist');
    return;
  }

  const reviewLog = logPath(cardId, 'review');
  const reviewFile = path.join(projectPath, '.review-complete');

  try { fs.unlinkSync(reviewFile); } catch (_) {}

  cards.setStatus(cardId, 'reviewing');
  broadcast('card-updated', cards.get(cardId));
  pipeline.setActivity(cardId, 'review', 'AI reviewer analyzing code...');
  pipeline.trackPhase(cardId, 'review', 'start');

  const header = '[' + new Date().toISOString() + '] AI Review started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\n---\n';
  fs.writeFileSync(reviewLog, header);
  log.info({ cardId, title: card.title }, 'autoReview started');

  let customCriteria = '';
  const customReviewPath = path.join(projectPath, '.kanban-review.md');
  try {
    if (fs.existsSync(customReviewPath)) {
      customCriteria = fs.readFileSync(customReviewPath, 'utf-8').trim();
    }
  } catch (_) {}

  const promptParts = [
    'You are a senior code reviewer. Review ALL code in this project thoroughly.',
    '',
    '## Check For',
    '1. Code quality: readability, DRY, KISS, single responsibility, no dead code',
    '2. Security: injection, XSS, CSRF, input validation, secrets in code, OWASP Top 10',
    '3. Performance: unnecessary loops, missing caching, large bundles, N+1 queries',
    '4. Accessibility: WCAG 2.2 AA, semantic HTML, ARIA labels, keyboard nav, color contrast',
    '5. Completeness: all features working, no TODO stubs, no placeholder content',
    '6. Error handling: proper boundaries, user-friendly messages, no swallowed errors',
  ];

  if (customCriteria) {
    promptParts.push('');
    promptParts.push('## Project-Specific Review Criteria');
    promptParts.push(customCriteria);
  }

  promptParts.push('');
  promptParts.push('## Scoring (1-10)');
  promptParts.push('- 9-10: Production ready, exemplary');
  promptParts.push('- 7-8: Good quality, minor improvements possible');
  promptParts.push('- 5-6: Acceptable, some issues need attention');
  promptParts.push('- 3-4: Significant problems');
  promptParts.push('- 1-2: Major rewrites needed');
  promptParts.push('');
  promptParts.push('Create .review-complete in the project root with this EXACT JSON format:');
  promptParts.push('{"score":NUMBER,"summary":"Brief overall assessment","findings":[{"severity":"critical|warning|info","category":"security|quality|performance|accessibility|completeness","message":"Description","file":"path/to/file"}],"autoApprove":BOOLEAN,"needsHumanApproval":BOOLEAN}');
  promptParts.push('');
  promptParts.push('Set autoApprove to true ONLY if score >= 8 AND zero critical findings.');
  promptParts.push('Set needsHumanApproval to true ONLY for genuinely dangerous operations: destructive file deletions affecting production data, mass database changes, rm -rf of important directories, removing security controls. Normal code issues, missing features, or low scores do NOT need human approval — those get auto-fixed.');
  promptParts.push('You have full access to all tools — read every file, search for patterns, run checks. Be thorough but fair. Focus your review ONLY on what this specific card was supposed to build — do not penalize for features belonging to other cards/phases.');

  const cp = getCustomPrompts();
  if (cp.reviewCriteria) {
    promptParts.push('');
    promptParts.push('## Additional Review Criteria');
    promptParts.push(cp.reviewCriteria);
  }

  const run = runClaudeSilent({
    id: 'review-' + cardId,
    cardId: cardId,
    cwd: projectPath,
    prompt: promptParts.join('\n'),
    logFile: reviewLog,
  });

  pipeline.trackPid(cardId, run.pid);

  let pollCount = 0;
  const maxPoll = 180; // 15 minutes

  const reviewInterval = setInterval(function() {
    pollCount++;
    try {
      const cardNow = cards.get(cardId);
      if (!cardNow) { clearInterval(reviewInterval); return; }
      if (cardNow.status !== 'reviewing' && !fs.existsSync(reviewFile)) {
        clearInterval(reviewInterval);
        return;
      }

      if (fs.existsSync(reviewFile)) {
        clearInterval(reviewInterval);
        pipeline.trackPhase(cardId, 'review', 'end');
        const content = fs.readFileSync(reviewFile, 'utf-8').trim();

        try { fs.appendFileSync(reviewLog, '\n---\n[' + new Date().toISOString() + '] Review completed\n' + content + '\n'); } catch (_) {}

        try {
          const data = JSON.parse(content);
          const score = data.score || 0;
          const criticals = (data.findings || []).filter(function(f) { return f.severity === 'critical'; }).length;

          cards.setReviewData(cardId, score, content);

          const fixCount = pipeline.getReviewFixCount(cardId);
          const needsHuman = data.needsHumanApproval === true;

          // Progressive trust: proven projects can auto-approve at lower thresholds
          let approveThreshold = 8;
          try {
            const intelligence = require('./intelligence');
            const trust = intelligence.getProjectTrust(projectPath);
            approveThreshold = trust.autoApproveThreshold;
          } catch (_) {}

          if (score >= approveThreshold && criticals === 0 && !needsHuman) {
            // Auto-approve
            pipeline.deleteReviewFixCount(cardId);
            pipeline.setActivity(cardId, 'approve', 'Score ' + score + '/10 — auto-approving...');
            cards.setStatus(cardId, 'complete');
            cards.setApprovedBy(cardId, 'ai');
            cards.move(cardId, 'done');
            // Intelligence: learn from successful build
            try { require('./intelligence').learnFromBuild(cardId); } catch (_) {}
            // Spec intelligence: score spec effectiveness (auto-approved, fix rounds completed before this review)
            try { require('./spec-intelligence').computeSpecEffectiveness(cardId, score, fixCount, true); } catch (_) {}
            snapshot.clear(cardId);
            broadcast('card-updated', cards.get(cardId));
            broadcast('toast', { message: 'AI Review: ' + score + '/10 — Auto-approved!', type: 'success' });
            sendWebhook('auto-approved', { cardId: cardId, title: card.title, score: score });

            pipeline.setActivity(cardId, 'changelog', 'Updating changelog...');
            git.autoChangelog(cardId);
            pipeline.setActivity(cardId, 'git', 'Git commit & push...');
            git.autoCommit(cardId);
            pipeline.setActivity(cardId, 'done', 'Complete — score ' + score + '/10');
            pipeline.releaseProjectLock(cardId);
            pipeline.checkUnblock();

            // Single-project mode: check if all siblings done → complete parent initiative
            checkParentInitiativeComplete(cardId);
          } else if (needsHuman) {
            // Dangerous ops — human approval required
            pipeline.deleteReviewFixCount(cardId);
            pipeline.setActivity(cardId, 'review', 'Score ' + score + '/10 — flagged for human approval (destructive ops)');
            cards.setStatus(cardId, 'idle');
            broadcast('card-updated', cards.get(cardId));
            broadcast('toast', { message: 'AI Review: Flagged for human approval — destructive operations detected.', type: 'error' });
            sendWebhook('review-needs-human', { cardId: cardId, title: card.title, score: score, reason: 'destructive_ops' });
            pipeline.releaseProjectLock(cardId);
          } else if (fixCount < runtime.maxReviewFixAttempts) {
            // Score < 8 — auto-fix and re-review
            pipeline.setReviewFixCount(cardId, fixCount + 1);
            const findingCount = (data.findings || []).length;
            pipeline.setActivity(cardId, 'fix', 'Score ' + score + '/10 (attempt ' + (fixCount + 1) + '/' + runtime.maxReviewFixAttempts + ') — auto-fixing ' + findingCount + ' findings...');
            cards.setStatus(cardId, 'fixing');
            broadcast('card-updated', cards.get(cardId));
            broadcast('toast', { message: 'AI Review: ' + score + '/10 — Auto-fixing (attempt ' + (fixCount + 1) + '/' + runtime.maxReviewFixAttempts + ')...', type: 'info' });
            autoFixFindings(cardId, data.findings || []);
          } else {
            // Max fix attempts exhausted — human review
            pipeline.deleteReviewFixCount(cardId);
            // Spec intelligence: score spec effectiveness (exhausted all fix attempts)
            try { require('./spec-intelligence').computeSpecEffectiveness(cardId, score, fixCount, false); } catch (_) {}
            pipeline.setActivity(cardId, 'review', 'Score ' + score + '/10 — ' + runtime.maxReviewFixAttempts + ' fix attempts exhausted, needs human review');
            cards.setStatus(cardId, 'idle');
            broadcast('card-updated', cards.get(cardId));
            broadcast('toast', { message: 'AI Review: ' + score + '/10 — ' + runtime.maxReviewFixAttempts + ' fix attempts exhausted. Human review needed.', type: 'error' });
            sendWebhook('review-needs-human', { cardId: cardId, title: card.title, score: score, criticals: criticals, reason: 'max_attempts' });
            pipeline.releaseProjectLock(cardId);
          }
        } catch (parseErr) {
          log.error({ cardId, err: parseErr.message }, 'Review parse error');
          cards.setStatus(cardId, 'idle');
          broadcast('card-updated', cards.get(cardId));
          try { fs.appendFileSync(reviewLog, '\n[REVIEW] Failed to parse review JSON: ' + parseErr.message + '\n'); } catch (_) {}
          pipeline.releaseProjectLock(cardId);
        }

        try { fs.unlinkSync(reviewFile); } catch (_) {}
      }

      // Rate-limit fast-fail
      if (pollCount >= runtime.rateLimitMinPolls && pollCount % 3 === 0) {
        const rl = detectRateLimit(reviewLog);
        if (rl.detected) {
          clearInterval(reviewInterval);
          pipeline.trackPhase(cardId, 'review', 'end');
          pipeline.handleRateLimitDetected(cardId, 'review', reviewLog);
          return;
        }
      }

      if (pollCount >= maxPoll) {
        clearInterval(reviewInterval);
        pipeline.trackPhase(cardId, 'review', 'end');
        cards.setStatus(cardId, 'idle');
        broadcast('card-updated', cards.get(cardId));
        try { fs.appendFileSync(reviewLog, '\n[REVIEW] Timed out after 15 minutes\n'); } catch (_) {}
        broadcast('toast', { message: 'AI Review timed out for: ' + card.title, type: 'error' });
        pipeline.releaseProjectLock(cardId);
      }
    } catch (err) {
      log.error({ cardId, err: err.message }, 'autoReview poll error');
    }
  }, 5000);
}

function autoFixFindings(cardId, findings) {
  const pipeline = require('./pipeline');

  const card = cards.get(cardId);
  if (!card || !card.project_path) return;

  const projectPath = card.project_path;
  const fixLog = logPath(cardId, 'review-fix');
  const fixFile = path.join(projectPath, '.review-fix-complete');

  try { fs.unlinkSync(fixFile); } catch (_) {}

  const header = '[' + new Date().toISOString() + '] Auto-fix review findings started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath
    + '\nFindings: ' + findings.length + '\n---\n';
  fs.writeFileSync(fixLog, header);
  pipeline.setActivity(cardId, 'fix', 'Claude fixing ' + findings.length + ' review findings...');
  log.info({ cardId, findingCount: findings.length }, 'autoFixFindings started');

  const findingsList = findings.map(function(f) {
    return '- [' + f.severity + '] ' + f.category + ': ' + f.message + (f.file ? ' (' + f.file + ')' : '');
  }).join('\n');

  const prompt = [
    'You are an autonomous code fixer. Fix ALL the review findings listed below.',
    '',
    '## Review Findings to Fix',
    findingsList,
    '',
    '## Instructions',
    '1. Read each file mentioned in the findings',
    '2. Fix each issue — do NOT break existing functionality',
    '3. For accessibility issues: fix color contrast, add ARIA labels, fix landmarks',
    '4. For security issues: fix input validation, encoding, CSP headers',
    '5. For quality issues: clean up code, remove dead code, fix naming',
    '6. Test that the application still works after your fixes',
    '',
    'When done, create .review-fix-complete in the project root:',
    '{"status":"fixed","summary":"What was fixed","files_changed":["list"]}',
  ].join('\n');

  const run = runClaudeSilent({
    id: 'review-fix-' + cardId,
    cardId: cardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: fixLog,
  });

  pipeline.trackPid(cardId, run.pid);

  let pollCount = 0;
  const maxPoll = 120; // 10 minutes

  const fixInterval = setInterval(function() {
    pollCount++;
    try {
      if (fs.existsSync(fixFile)) {
        clearInterval(fixInterval);
        const content = fs.readFileSync(fixFile, 'utf-8').trim();
        try { fs.appendFileSync(fixLog, '\n---\n[' + new Date().toISOString() + '] Fix completed\n' + content + '\n'); } catch (_) {}

        try {
          const data = JSON.parse(content);
          log.info({ cardId, summary: data.summary || 'done' }, 'autoFixFindings completed');
          broadcast('toast', { message: 'Auto-fix done: ' + (data.summary || 'Fixed findings'), type: 'success' });
        } catch (_) {}

        try { fs.unlinkSync(fixFile); } catch (_) {}

        // Re-review after fix
        pipeline.setActivity(cardId, 'review', 'Fixes applied — re-reviewing...');
        autoReview(cardId);
      }

      // Rate-limit fast-fail for fix
      if (pollCount >= runtime.rateLimitMinPolls && pollCount % 3 === 0) {
        const rl = detectRateLimit(fixLog);
        if (rl.detected) {
          clearInterval(fixInterval);
          pipeline.handleRateLimitDetected(cardId, 'fix', fixLog);
          return;
        }
      }

      if (pollCount >= maxPoll) {
        clearInterval(fixInterval);
        pipeline.setActivity(cardId, 'fix', 'Auto-fix timed out — needs human review');
        cards.setStatus(cardId, 'idle');
        broadcast('card-updated', cards.get(cardId));
        try { fs.appendFileSync(fixLog, '\n[FIX] Timed out after 10 minutes\n'); } catch (_) {}
        broadcast('toast', { message: 'Auto-fix timed out. Human review needed.', type: 'error' });
        pipeline.releaseProjectLock(cardId);
      }
    } catch (err) {
      log.error({ cardId, err: err.message }, 'autoFixFindings poll error');
    }
  }, 5000);
}

// --- Parent-Child Initiative Lifecycle ---
// When a child card completes, check if ALL siblings under the same parent are done.
// If so, mark the parent brainstorm card as complete and trigger next discovery cycle.

function checkParentInitiativeComplete(childCardId) {
  const childCard = cards.get(childCardId);
  if (!childCard || !childCard.parent_card_id) return;

  const parentId = childCard.parent_card_id;
  const incomplete = cards.countIncompleteChildren(parentId);

  if (incomplete > 0) {
    // Not all siblings done yet — enqueue the next unstarted sibling
    const siblings = cards.getByParent(parentId);
    const pipeline = require('./pipeline');
    for (let i = 0; i < siblings.length; i++) {
      const sib = siblings[i];
      if (sib.column_name === 'todo' && sib.status === 'idle') {
        try {
          pipeline.enqueue(sib.id, 0);
          break; // Only start one at a time
        } catch (_) {}
      }
    }
    return;
  }

  // All children done — mark parent initiative complete
  const parentCard = cards.get(parentId);
  if (!parentCard) return;

  const pipeline = require('./pipeline');

  cards.setStatus(parentId, 'complete');
  cards.move(parentId, 'done');
  pipeline.setActivity(parentId, 'done', 'All child tasks complete — initiative finished');
  broadcast('card-updated', cards.get(parentId));
  broadcast('toast', { message: 'Initiative complete: ' + parentCard.title, type: 'success' });
  sendWebhook('initiative-complete', { parentId: parentId, title: parentCard.title });

  // Auto-commit the whole initiative
  git.autoChangelog(parentId);
  git.autoCommit(parentId);

  // Trigger next discovery cycle (single-project mode)
  if (runtime.mode === 'single-project') {
    const autoDiscover = require('./auto-discover');
    // Small delay to let things settle
    setTimeout(function() {
      autoDiscover.runDiscovery();
    }, 5000);
  }
}

module.exports = { autoReview: autoReview, autoFixFindings: autoFixFindings, checkParentInitiativeComplete: checkParentInitiativeComplete };
