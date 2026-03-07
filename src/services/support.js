const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { IS_WIN, IS_MAC, PROJECTS_ROOT, DATA_DIR } = require('../config');
const { cards, sessions, audit } = require('../db');
const snapshot = require('./snapshot');
const { suggestName } = require('../lib/helpers');

// --- Security: Project path validation (C3 fix) ---
var resolvedProjectsRoot = path.resolve(PROJECTS_ROOT);
var SHELL_METACHAR_RE = /[;&|`$%^<>!(){}[\]"'#~]/;

function validateProjectPath(p) {
  if (!p || typeof p !== 'string') return 'Project path is required';
  if (!path.isAbsolute(p)) return 'Project path must be absolute';
  if (SHELL_METACHAR_RE.test(p)) return 'Project path contains disallowed characters';
  var resolved = path.resolve(p);
  if (resolved !== resolvedProjectsRoot && !resolved.startsWith(resolvedProjectsRoot + path.sep)) {
    return 'Project path must be under PROJECTS_ROOT (' + PROJECTS_ROOT + ')';
  }
  return null; // valid
}

// --- Security: Allowed preview commands (C4 fix) ---
var ALLOWED_RUN_RE = /^(pnpm|npm|node)\s/;
function isAllowedRunCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  if (!ALLOWED_RUN_RE.test(cmd)) return false;
  // Block shell metacharacters in run commands
  if (/[;&|`$<>!]/.test(cmd)) return false;
  return true;
}

// --- Project Detection ---

function detectProject(title) {
  var name = suggestName(title);
  var nameNoHyphens = name.replace(/-/g, '');
  var words = title.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 2; });

  var entries;
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(function(e) { return e.isDirectory(); })
      .map(function(e) { return e.name; })
      .filter(function(e) { return e !== '$RECYCLE.BIN' && e !== 'System Volume Information'; });
  } catch (_) { return { matches: [], suggestedName: name, meaningfulWords: words }; }

  var matches = [];

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var lower = entry.toLowerCase();
    var lowerNoHyphens = lower.replace(/-/g, '');
    var score = 0;

    if (lower === name || lowerNoHyphens === nameNoHyphens) score = 100;
    else if (lower.includes(name) || name.includes(lower)) score = 80;
    else {
      var matched = words.filter(function(w) { return lower.includes(w); }).length;
      if (words.length > 0 && matched >= Math.ceil(words.length * 0.5)) {
        score = Math.round((matched / words.length) * 60);
      }
    }

    if (score > 0) {
      var fullPath = path.join(PROJECTS_ROOT, entry);
      var fileCount = 0;
      try { fileCount = snapshot.walkDir(fullPath).length; } catch (_) {}
      matches.push({ name: entry, path: fullPath, score: score, files: fileCount });
    }
  }

  matches.sort(function(a, b) { return b.score - a.score; });
  return { matches: matches.slice(0, 8), suggestedName: name, projectsRoot: PROJECTS_ROOT };
}

function analyzeProject(projectPath) {
  var files = snapshot.walkDir(projectPath);
  var analysis = ['Project: ' + path.basename(projectPath)];
  analysis.push('Location: ' + projectPath);
  analysis.push('Files: ' + files.length);
  analysis.push('');
  analysis.push('File tree:');
  var treeFiles = files.slice(0, 100);
  for (var i = 0; i < treeFiles.length; i++) {
    analysis.push('  ' + treeFiles[i]);
  }
  if (files.length > 100) analysis.push('  ... and ' + (files.length - 100) + ' more');

  var keyFiles = ['package.json', 'README.md', 'CLAUDE.md', '.env.example', 'tsconfig.json'];
  for (var k = 0; k < keyFiles.length; k++) {
    var fp = path.join(projectPath, keyFiles[k]);
    if (fs.existsSync(fp)) {
      try {
        var content = fs.readFileSync(fp, 'utf-8');
        analysis.push('');
        analysis.push('--- ' + keyFiles[k] + ' ---');
        analysis.push(content.slice(0, 2000));
      } catch (_) {}
    }
  }

  return analysis.join('\n');
}

// --- Editor Actions ---

function openInVSCode(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path assigned');
  var err = validateProjectPath(card.project_path);
  if (err) throw new Error(err);
  var child = spawn('code', [card.project_path], { shell: true, detached: true, stdio: 'ignore' });
  child.on('error', function(err) { console.error('VSCode spawn error:', err.message); });
  child.unref();
}

function openTerminal(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  var err = validateProjectPath(card.project_path);
  if (err) throw new Error(err);
  var p = card.project_path;
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + p + '"'], { detached: true, stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    spawn('open', ['-a', 'Terminal', p], { detached: true, stdio: 'ignore' }).unref();
  } else {
    var child = spawn('gnome-terminal', ['--working-directory=' + p], { detached: true, stdio: 'ignore' });
    child.on('error', function() {
      spawn('xterm', ['-e', 'bash'], { cwd: p, detached: true, stdio: 'ignore' }).unref();
    });
    child.unref();
  }
}

function openClaude(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  var err = validateProjectPath(card.project_path);
  if (err) throw new Error(err);
  var p = card.project_path;
  if (IS_WIN) {
    // Path validated by validateProjectPath — no shell metacharacters possible
    spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + p + '" && set CLAUDECODE= && claude'], { detached: true, stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    var script = "cd '" + p.replace(/'/g, "'\\''") + "' && unset CLAUDECODE && claude";
    spawn('osascript', ['-e', 'tell app "Terminal" to do script "' + script.replace(/"/g, '\\"') + '"'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    var bashCmd = "cd '" + p.replace(/'/g, "'\\''") + "' && unset CLAUDECODE && claude; exec bash";
    var child = spawn('gnome-terminal', ['--', 'bash', '-c', bashCmd], { detached: true, stdio: 'ignore' });
    child.on('error', function() {
      spawn('xterm', ['-e', 'bash', '-c', bashCmd], { detached: true, stdio: 'ignore' }).unref();
    });
    child.unref();
  }
}

// --- Diff Viewer ---

function getDiff(cardId) {
  var snapDir = path.join(DATA_DIR, 'snapshots', 'card-' + cardId);
  var manifestPath = path.join(snapDir, '_manifest.json');
  if (!fs.existsSync(manifestPath)) return { error: 'No snapshot available' };

  var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  var projectPath = manifest.projectPath;

  if (!fs.existsSync(projectPath)) return { error: 'Project directory not found' };

  var originalFiles = new Set(manifest.files);
  var currentFiles;
  try { currentFiles = new Set(snapshot.walkDir(projectPath)); } catch (_) { currentFiles = new Set(); }

  var diff = { added: [], removed: [], modified: [], unchanged: 0, projectPath: projectPath };

  for (var f of currentFiles) {
    if (!originalFiles.has(f)) {
      var addedPath = path.join(projectPath, f);
      try {
        var buf = fs.readFileSync(addedPath);
        var isText = !buf.includes(0);
        if (isText) {
          diff.added.push({ file: f, content: buf.toString('utf-8').slice(0, 50000), lines: buf.toString('utf-8').split('\n').length });
        } else {
          diff.added.push({ file: f, binary: true, size: buf.length });
        }
      } catch (_) {
        diff.added.push({ file: f, error: 'Could not read' });
      }
    }
  }

  for (var f of originalFiles) {
    if (!currentFiles.has(f)) diff.removed.push(f);
  }

  for (var f of originalFiles) {
    if (!currentFiles.has(f)) continue;
    var origPath = path.join(snapDir, 'files', f);
    var currPath = path.join(projectPath, f);
    try {
      var origBuf = fs.readFileSync(origPath);
      var currBuf = fs.readFileSync(currPath);
      if (!origBuf.equals(currBuf)) {
        var isText = !origBuf.includes(0) && !currBuf.includes(0);
        if (isText) {
          var origText = origBuf.toString('utf-8');
          var currText = currBuf.toString('utf-8');
          diff.modified.push({
            file: f,
            original: origText.slice(0, 50000),
            current: currText.slice(0, 50000),
            origLines: origText.split('\n').length,
            currLines: currText.split('\n').length,
          });
        } else {
          diff.modified.push({ file: f, binary: true, origSize: origBuf.length, currSize: currBuf.length });
        }
      } else {
        diff.unchanged++;
      }
    } catch (_) {
      diff.modified.push({ file: f, error: 'Could not read' });
    }
  }

  return diff;
}

// --- Preview / Run ---

function previewProject(cardId) {
  var card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  var pathErr = validateProjectPath(card.project_path);
  if (pathErr) throw new Error(pathErr);

  var projectPath = card.project_path;
  var completionFile = path.join(projectPath, '.task-complete');
  var runCommand = null;

  try {
    if (fs.existsSync(completionFile)) {
      var data = JSON.parse(fs.readFileSync(completionFile, 'utf-8'));
      runCommand = data.run_command;
    }
  } catch (_) {}

  if (!runCommand) {
    var pkgPath = path.join(projectPath, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts) {
          if (pkg.scripts.dev) runCommand = 'pnpm dev';
          else if (pkg.scripts.start) runCommand = 'pnpm start';
          else if (pkg.scripts.preview) runCommand = 'pnpm preview';
        }
      }
    } catch (_) {}
  }

  if (!runCommand) throw new Error('No run command found in .task-complete or package.json');
  if (!isAllowedRunCommand(runCommand)) throw new Error('Run command not allowed: ' + runCommand + '. Must start with pnpm/npm/node and contain no shell metacharacters.');

  var fullCmd = 'pnpm install && ' + runCommand;
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + projectPath + '" && ' + fullCmd], { detached: true, stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    var safeP = projectPath.replace(/'/g, "'\\''");
    spawn('osascript', ['-e', 'tell app "Terminal" to do script "cd \'' + safeP + '\' && ' + fullCmd + '"'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    var safeP = projectPath.replace(/'/g, "'\\''");
    spawn('gnome-terminal', ['--', 'bash', '-c', "cd '" + safeP + "' && " + fullCmd + '; exec bash'], { detached: true, stdio: 'ignore' }).unref();
  }

  return { success: true, command: runCommand };
}

// --- Export Board ---

// H3 fix: export only card data by default. Sessions + audit only when opts.full (admin).
function exportBoard(opts) {
  var all = cards.getAll();
  var archived = cards.getArchived();
  var result = {
    exportedAt: new Date().toISOString(),
    version: '1.8.1',
    cards: all.map(function(c) {
      return {
        id: c.id, title: c.title, description: c.description, spec: c.spec,
        column: c.column_name, status: c.status, labels: c.labels, depends_on: c.depends_on,
        project_path: c.project_path, review_score: c.review_score,
        phase_durations: c.phase_durations, created_at: c.created_at, updated_at: c.updated_at,
      };
    }),
    archived: archived.map(function(c) {
      return {
        id: c.id, title: c.title, description: c.description, column: c.column_name,
        labels: c.labels, review_score: c.review_score, project_path: c.project_path,
        created_at: c.created_at, updated_at: c.updated_at,
      };
    }),
  };
  if (opts && opts.full) {
    result.sessions = sessions.getAll();
    result.auditLog = audit.all();
  }
  return result;
}

// --- Metrics ---

function getMetrics() {
  var all = cards.getAll().concat(cards.getArchived());
  var scores = [];
  var durations = { brainstorm: [], build: [], review: [] };
  var projectCounts = {};
  var completedByDay = {};
  var labelCounts = {};

  for (var i = 0; i < all.length; i++) {
    var card = all[i];

    if (card.project_path) {
      var proj = path.basename(card.project_path);
      projectCounts[proj] = (projectCounts[proj] || 0) + 1;
    }

    if (card.review_score > 0) scores.push(card.review_score);

    if (card.phase_durations) {
      try {
        var pd = JSON.parse(card.phase_durations);
        var phases = ['brainstorm', 'build', 'review'];
        for (var pi = 0; pi < phases.length; pi++) {
          if (pd[phases[pi]] && pd[phases[pi]].duration) durations[phases[pi]].push(pd[phases[pi]].duration);
        }
      } catch (_) {}
    }

    if (card.column_name === 'done' || card.column_name === 'archive') {
      var day = (card.updated_at || '').slice(0, 10);
      if (day) completedByDay[day] = (completedByDay[day] || 0) + 1;
    }

    if (card.labels) {
      var labelArr = card.labels.split(',');
      for (var li = 0; li < labelArr.length; li++) {
        var l = labelArr[li].trim();
        if (l) labelCounts[l] = (labelCounts[l] || 0) + 1;
      }
    }
  }

  function avg(arr) { return arr.length > 0 ? Math.round(arr.reduce(function(a, b) { return a + b; }, 0) / arr.length) : 0; }

  return {
    totalCards: all.length,
    avgReviewScore: scores.length > 0 ? Math.round(avg(scores) * 10) / 10 : 0,
    avgDurations: {
      brainstorm: Math.round(avg(durations.brainstorm) / 1000),
      build: Math.round(avg(durations.build) / 1000),
      review: Math.round(avg(durations.review) / 1000),
    },
    completedByDay: completedByDay,
    topProjects: Object.entries(projectCounts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10),
    labelDistribution: labelCounts,
    scoreDistribution: scores,
  };
}

module.exports = {
  detectProject: detectProject,
  analyzeProject: analyzeProject,
  openInVSCode: openInVSCode,
  openTerminal: openTerminal,
  openClaude: openClaude,
  getDiff: getDiff,
  previewProject: previewProject,
  exportBoard: exportBoard,
  getMetrics: getMetrics,
  validateProjectPath: validateProjectPath,
};
