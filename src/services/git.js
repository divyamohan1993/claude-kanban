const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { cards } = require('../db');
const { logPath } = require('../lib/helpers');

function autoCommit(cardId) {
  const card = cards.get(cardId);
  if (!card || !card.project_path) return { success: false, reason: 'No project path' };

  const projectPath = card.project_path;
  const log = logPath(cardId, 'build');
  const execOpts = { cwd: projectPath, stdio: 'pipe', windowsHide: true, timeout: 30000 };

  try {
    const isGitRepo = fs.existsSync(path.join(projectPath, '.git'));
    if (!isGitRepo) {
      execFileSync('git', ['init'], execOpts);
      const gitignorePath = path.join(projectPath, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n.task-complete\n.brainstorm-output-*\n');
      }
    }

    execFileSync('git', ['add', '-A'], execOpts);

    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], execOpts);
      try { fs.appendFileSync(log, '\n[AUTO-GIT] No changes to commit\n'); } catch (_) {}
      return { success: true, action: 'no-changes' };
    } catch (_) {
      // There are staged changes — continue
    }

    const msg = 'feat: ' + card.title + '\n\nKanban card #' + cardId + ' — approved and auto-committed.\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>';
    execFileSync('git', ['commit', '-m', msg], execOpts);
    try { fs.appendFileSync(log, '\n[AUTO-GIT] Committed: ' + card.title + '\n'); } catch (_) {}

    try {
      const remotes = execFileSync('git', ['remote'], execOpts).toString().trim();
      if (remotes) {
        const branch = execFileSync('git', ['branch', '--show-current'], execOpts).toString().trim() || 'main';
        execFileSync('git', ['push', 'origin', branch], execOpts);
        try { fs.appendFileSync(log, '[AUTO-GIT] Pushed to origin/' + branch + '\n'); } catch (_) {}
        return { success: true, action: 'committed-and-pushed', branch: branch };
      }
    } catch (pushErr) {
      try { fs.appendFileSync(log, '[AUTO-GIT] Push failed: ' + pushErr.message + '\n'); } catch (_) {}
    }

    return { success: true, action: 'committed' };
  } catch (err) {
    try { fs.appendFileSync(log, '\n[AUTO-GIT] Error: ' + err.message + '\n'); } catch (_) {}
    return { success: false, reason: err.message };
  }
}

function baselineCommit(cardId) {
  const card = cards.get(cardId);
  if (!card || !card.project_path) return { success: false, reason: 'No project path' };

  const projectPath = card.project_path;
  const markerPath = path.join(projectPath, '.pre-automation-checkpoint');

  // One baseline per project — skip if marker already exists
  if (fs.existsSync(markerPath)) {
    return { success: true, action: 'already-checkpointed' };
  }

  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath, { recursive: true });
  }

  const execOpts = { cwd: projectPath, stdio: 'pipe', windowsHide: true, timeout: 30000 };

  try {
    // Init git if needed
    const isGitRepo = fs.existsSync(path.join(projectPath, '.git'));
    if (!isGitRepo) {
      execFileSync('git', ['init'], execOpts);
      const gitignorePath = path.join(projectPath, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n.task-complete\n.brainstorm-output-*\n');
      }
    }

    // Create 0-byte safety checkpoint marker
    fs.writeFileSync(markerPath, '');

    // Stage everything
    execFileSync('git', ['add', '-A'], execOpts);

    const msg = 'checkpoint: pre-automation baseline — card #' + cardId
      + '\n\nSafety snapshot before kanban automation touches this project.'
      + '\nCard: "' + card.title + '"'
      + '\nRevert to this commit to restore the pre-automation state.';

    // Commit — use allow-empty if nothing staged (marker already existed)
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], execOpts);
      execFileSync('git', ['commit', '--allow-empty', '-m', msg], execOpts);
    } catch (_) {
      execFileSync('git', ['commit', '-m', msg], execOpts);
    }

    return { success: true, action: 'baseline-committed' };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

function autoChangelog(cardId) {
  const card = cards.get(cardId);
  if (!card || !card.project_path) return { success: false, reason: 'No project path' };

  const projectPath = card.project_path;
  const changelogPath = path.join(projectPath, 'CHANGELOG.md');
  const today = new Date().toISOString().slice(0, 10);
  const title = card.title || 'Untitled';

  let summary = '';
  const completionFile = path.join(projectPath, '.task-complete');
  try {
    if (fs.existsSync(completionFile)) {
      const raw = fs.readFileSync(completionFile, 'utf-8').trim();
      const data = JSON.parse(raw);
      if (data.summary) summary = data.summary;
      else if (data.message) summary = data.message;
    }
  } catch (_) {}

  if (!summary) summary = card.description ? card.description.split('\n')[0] : title;

  let changeType = 'Changed';
  const lowerTitle = title.toLowerCase();
  const labels = (card.labels || '').toLowerCase();
  if (labels.includes('bug') || lowerTitle.startsWith('fix') || lowerTitle.includes('bug')) changeType = 'Fixed';
  else if (labels.includes('feature') || lowerTitle.startsWith('add') || lowerTitle.startsWith('new') || lowerTitle.startsWith('create')) changeType = 'Added';
  else if (lowerTitle.startsWith('remove') || lowerTitle.startsWith('delete')) changeType = 'Removed';

  const entry = '- ' + title + (summary !== title ? ' — ' + summary : '');

  try {
    let existing = '';
    if (fs.existsSync(changelogPath)) {
      existing = fs.readFileSync(changelogPath, 'utf-8');
    }

    const dateHeader = '## [' + today + ']';
    const typeHeader = '### ' + changeType;

    if (existing.includes(dateHeader)) {
      const dateIdx = existing.indexOf(dateHeader);
      const afterDate = existing.indexOf('\n', dateIdx) + 1;
      const nextDateIdx = existing.indexOf('\n## [', afterDate);
      const dateSection = nextDateIdx === -1 ? existing.slice(afterDate) : existing.slice(afterDate, nextDateIdx);

      if (dateSection.includes(typeHeader)) {
        const typeIdx = existing.indexOf(typeHeader, dateIdx);
        const afterType = existing.indexOf('\n', typeIdx) + 1;
        existing = existing.slice(0, afterType) + entry + '\n' + existing.slice(afterType);
      } else {
        existing = existing.slice(0, afterDate) + '\n' + typeHeader + '\n' + entry + '\n' + existing.slice(afterDate);
      }
      fs.writeFileSync(changelogPath, existing);
    } else {
      const newSection = dateHeader + '\n\n' + typeHeader + '\n' + entry + '\n';
      if (existing) {
        let insertIdx = existing.indexOf('\n## [');
        if (insertIdx === -1) insertIdx = existing.indexOf('\n---');
        if (insertIdx === -1) {
          const firstNewline = existing.indexOf('\n');
          insertIdx = firstNewline === -1 ? existing.length : firstNewline + 1;
        }
        existing = existing.slice(0, insertIdx) + '\n' + newSection + '\n' + existing.slice(insertIdx);
      } else {
        existing = '# Changelog\n\n' + newSection;
      }
      fs.writeFileSync(changelogPath, existing);
    }

    return { success: true, entry: entry, type: changeType };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

module.exports = { autoCommit: autoCommit, baselineCommit: baselineCommit, autoChangelog: autoChangelog };
