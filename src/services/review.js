const fs = require('fs');
const path = require('path');
const { runtime } = require('../config');
const { cards } = require('../db');
const { broadcast } = require('../lib/broadcast');
const snapshot = require('./snapshot');
const { logPath, sendWebhook } = require('../lib/helpers');
const { runClaudeSilent } = require('./claude-runner');
const { getCustomPrompts } = require('./usage');
const git = require('./git');

function autoReview(cardId) {
  // Lazy require pipeline to avoid circular dep
  var pipeline = require('./pipeline');

  var card = cards.get(cardId);
  if (!card || !card.project_path) {
    console.error('autoReview: card', cardId, 'not found or no project_path');
    return;
  }

  var projectPath = card.project_path;
  if (!fs.existsSync(projectPath)) {
    console.error('autoReview: project path does not exist:', projectPath);
    return;
  }

  var reviewLog = logPath(cardId, 'review');
  var reviewFile = path.join(projectPath, '.review-complete');

  try { fs.unlinkSync(reviewFile); } catch (_) {}

  cards.setStatus(cardId, 'reviewing');
  broadcast('card-updated', cards.get(cardId));
  pipeline.setActivity(cardId, 'review', 'AI reviewer analyzing code...');
  pipeline.trackPhase(cardId, 'review', 'start');

  var header = '[' + new Date().toISOString() + '] AI Review started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath + '\n---\n';
  fs.writeFileSync(reviewLog, header);
  console.log('autoReview: started for card', cardId, '(' + card.title + ')');

  var customCriteria = '';
  var customReviewPath = path.join(projectPath, '.kanban-review.md');
  try {
    if (fs.existsSync(customReviewPath)) {
      customCriteria = fs.readFileSync(customReviewPath, 'utf-8').trim();
    }
  } catch (_) {}

  var promptParts = [
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

  var cp = getCustomPrompts();
  if (cp.reviewCriteria) {
    promptParts.push('');
    promptParts.push('## Additional Review Criteria');
    promptParts.push(cp.reviewCriteria);
  }

  var run = runClaudeSilent({
    id: 'review-' + cardId,
    cardId: cardId,
    cwd: projectPath,
    prompt: promptParts.join('\n'),
    logFile: reviewLog,
  });

  pipeline.trackPid(cardId, run.pid);

  var pollCount = 0;
  var maxPoll = 180; // 15 minutes

  var reviewInterval = setInterval(function() {
    pollCount++;
    try {
      var cardNow = cards.get(cardId);
      if (!cardNow) { clearInterval(reviewInterval); return; }
      if (cardNow.status !== 'reviewing' && !fs.existsSync(reviewFile)) {
        clearInterval(reviewInterval);
        return;
      }

      if (fs.existsSync(reviewFile)) {
        clearInterval(reviewInterval);
        pipeline.trackPhase(cardId, 'review', 'end');
        var content = fs.readFileSync(reviewFile, 'utf-8').trim();

        try { fs.appendFileSync(reviewLog, '\n---\n[' + new Date().toISOString() + '] Review completed\n' + content + '\n'); } catch (_) {}

        try {
          var data = JSON.parse(content);
          var score = data.score || 0;
          var criticals = (data.findings || []).filter(function(f) { return f.severity === 'critical'; }).length;

          cards.setReviewData(cardId, score, content);

          var fixCount = pipeline.getReviewFixCount(cardId);
          var needsHuman = data.needsHumanApproval === true;

          if (score >= 8 && criticals === 0 && !needsHuman) {
            // Auto-approve
            pipeline.deleteReviewFixCount(cardId);
            pipeline.setActivity(cardId, 'approve', 'Score ' + score + '/10 — auto-approving...');
            cards.setStatus(cardId, 'complete');
            cards.setApprovedBy(cardId, 'ai');
            cards.move(cardId, 'done');
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
            var findingCount = (data.findings || []).length;
            pipeline.setActivity(cardId, 'fix', 'Score ' + score + '/10 (attempt ' + (fixCount + 1) + '/' + runtime.maxReviewFixAttempts + ') — auto-fixing ' + findingCount + ' findings...');
            cards.setStatus(cardId, 'fixing');
            broadcast('card-updated', cards.get(cardId));
            broadcast('toast', { message: 'AI Review: ' + score + '/10 — Auto-fixing (attempt ' + (fixCount + 1) + '/' + runtime.maxReviewFixAttempts + ')...', type: 'info' });
            autoFixFindings(cardId, data.findings || []);
          } else {
            // Max fix attempts exhausted — human review
            pipeline.deleteReviewFixCount(cardId);
            pipeline.setActivity(cardId, 'review', 'Score ' + score + '/10 — ' + runtime.maxReviewFixAttempts + ' fix attempts exhausted, needs human review');
            cards.setStatus(cardId, 'idle');
            broadcast('card-updated', cards.get(cardId));
            broadcast('toast', { message: 'AI Review: ' + score + '/10 — ' + runtime.maxReviewFixAttempts + ' fix attempts exhausted. Human review needed.', type: 'error' });
            sendWebhook('review-needs-human', { cardId: cardId, title: card.title, score: score, criticals: criticals, reason: 'max_attempts' });
            pipeline.releaseProjectLock(cardId);
          }
        } catch (parseErr) {
          console.error('Review parse error:', parseErr.message);
          cards.setStatus(cardId, 'idle');
          broadcast('card-updated', cards.get(cardId));
          try { fs.appendFileSync(reviewLog, '\n[REVIEW] Failed to parse review JSON: ' + parseErr.message + '\n'); } catch (_) {}
          pipeline.releaseProjectLock(cardId);
        }

        try { fs.unlinkSync(reviewFile); } catch (_) {}
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
      console.error('autoReview poll error for card', cardId, ':', err.message);
    }
  }, 5000);
}

function autoFixFindings(cardId, findings) {
  var pipeline = require('./pipeline');

  var card = cards.get(cardId);
  if (!card || !card.project_path) return;

  var projectPath = card.project_path;
  var fixLog = logPath(cardId, 'review-fix');
  var fixFile = path.join(projectPath, '.review-fix-complete');

  try { fs.unlinkSync(fixFile); } catch (_) {}

  var header = '[' + new Date().toISOString() + '] Auto-fix review findings started\n'
    + 'Card: ' + card.title + '\nProject: ' + projectPath
    + '\nFindings: ' + findings.length + '\n---\n';
  fs.writeFileSync(fixLog, header);
  pipeline.setActivity(cardId, 'fix', 'Claude fixing ' + findings.length + ' review findings...');
  console.log('autoFixFindings: started for card', cardId, '(' + findings.length + ' findings)');

  var findingsList = findings.map(function(f) {
    return '- [' + f.severity + '] ' + f.category + ': ' + f.message + (f.file ? ' (' + f.file + ')' : '');
  }).join('\n');

  var prompt = [
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

  var run = runClaudeSilent({
    id: 'review-fix-' + cardId,
    cardId: cardId,
    cwd: projectPath,
    prompt: prompt,
    logFile: fixLog,
  });

  pipeline.trackPid(cardId, run.pid);

  var pollCount = 0;
  var maxPoll = 120; // 10 minutes

  var fixInterval = setInterval(function() {
    pollCount++;
    try {
      if (fs.existsSync(fixFile)) {
        clearInterval(fixInterval);
        var content = fs.readFileSync(fixFile, 'utf-8').trim();
        try { fs.appendFileSync(fixLog, '\n---\n[' + new Date().toISOString() + '] Fix completed\n' + content + '\n'); } catch (_) {}

        try {
          var data = JSON.parse(content);
          console.log('autoFixFindings: completed for card', cardId, '—', data.summary || 'done');
          broadcast('toast', { message: 'Auto-fix done: ' + (data.summary || 'Fixed findings'), type: 'success' });
        } catch (_) {}

        try { fs.unlinkSync(fixFile); } catch (_) {}

        // Re-review after fix
        pipeline.setActivity(cardId, 'review', 'Fixes applied — re-reviewing...');
        autoReview(cardId);
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
      console.error('autoFixFindings poll error:', err.message);
    }
  }, 5000);
}

module.exports = { autoReview: autoReview, autoFixFindings: autoFixFindings };
