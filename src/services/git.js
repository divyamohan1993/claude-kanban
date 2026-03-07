const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { cards } = require('../db');
const { logPath } = require('../lib/helpers');

function autoCommit(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) return { success: false, reason: 'No project path' };

  var projectPath = card.project_path;
  var log = logPath(cardId, 'build');
  var execOpts = { cwd: projectPath, stdio: 'pipe', windowsHide: true, timeout: 30000 };

  try {
    var isGitRepo = fs.existsSync(path.join(projectPath, '.git'));
    if (!isGitRepo) {
      execFileSync('git', ['init'], execOpts);
      var gitignorePath = path.join(projectPath, '.gitignore');
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

    var msg = 'feat: ' + card.title + '\n\nKanban card #' + cardId + ' — approved and auto-committed.\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>';
    execFileSync('git', ['commit', '-m', msg], execOpts);
    try { fs.appendFileSync(log, '\n[AUTO-GIT] Committed: ' + card.title + '\n'); } catch (_) {}

    try {
      var remotes = execFileSync('git', ['remote'], execOpts).toString().trim();
      if (remotes) {
        var branch = execFileSync('git', ['branch', '--show-current'], execOpts).toString().trim() || 'main';
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

function autoChangelog(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) return { success: false, reason: 'No project path' };

  var projectPath = card.project_path;
  var changelogPath = path.join(projectPath, 'CHANGELOG.md');
  var today = new Date().toISOString().slice(0, 10);
  var title = card.title || 'Untitled';

  var summary = '';
  var completionFile = path.join(projectPath, '.task-complete');
  try {
    if (fs.existsSync(completionFile)) {
      var raw = fs.readFileSync(completionFile, 'utf-8').trim();
      var data = JSON.parse(raw);
      if (data.summary) summary = data.summary;
      else if (data.message) summary = data.message;
    }
  } catch (_) {}

  if (!summary) summary = card.description ? card.description.split('\n')[0] : title;

  var changeType = 'Changed';
  var lowerTitle = title.toLowerCase();
  var labels = (card.labels || '').toLowerCase();
  if (labels.includes('bug') || lowerTitle.startsWith('fix') || lowerTitle.includes('bug')) changeType = 'Fixed';
  else if (labels.includes('feature') || lowerTitle.startsWith('add') || lowerTitle.startsWith('new') || lowerTitle.startsWith('create')) changeType = 'Added';
  else if (lowerTitle.startsWith('remove') || lowerTitle.startsWith('delete')) changeType = 'Removed';

  var entry = '- ' + title + (summary !== title ? ' — ' + summary : '');

  try {
    var existing = '';
    if (fs.existsSync(changelogPath)) {
      existing = fs.readFileSync(changelogPath, 'utf-8');
    }

    var dateHeader = '## [' + today + ']';
    var typeHeader = '### ' + changeType;

    if (existing.includes(dateHeader)) {
      var dateIdx = existing.indexOf(dateHeader);
      var afterDate = existing.indexOf('\n', dateIdx) + 1;
      var nextDateIdx = existing.indexOf('\n## [', afterDate);
      var dateSection = nextDateIdx === -1 ? existing.slice(afterDate) : existing.slice(afterDate, nextDateIdx);

      if (dateSection.includes(typeHeader)) {
        var typeIdx = existing.indexOf(typeHeader, dateIdx);
        var afterType = existing.indexOf('\n', typeIdx) + 1;
        existing = existing.slice(0, afterType) + entry + '\n' + existing.slice(afterType);
      } else {
        existing = existing.slice(0, afterDate) + '\n' + typeHeader + '\n' + entry + '\n' + existing.slice(afterDate);
      }
      fs.writeFileSync(changelogPath, existing);
    } else {
      var newSection = dateHeader + '\n\n' + typeHeader + '\n' + entry + '\n';
      if (existing) {
        var insertIdx = existing.indexOf('\n## [');
        if (insertIdx === -1) insertIdx = existing.indexOf('\n---');
        if (insertIdx === -1) {
          var firstNewline = existing.indexOf('\n');
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

module.exports = { autoCommit: autoCommit, autoChangelog: autoChangelog };
