const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { IS_WIN, IS_MAC, PROJECTS_ROOT, DATA_DIR, runtime } = require('../config');
const { cards, sessions, audit } = require('../db');
const snapshot = require('./snapshot');
const { suggestName } = require('../lib/helpers');

// --- Security: Project path validation (C3 fix) ---
const resolvedProjectsRoot = path.resolve(PROJECTS_ROOT);
const SHELL_METACHAR_RE = /[;&|`$%^<>!(){}[\]"'#~]/;

// System/OS directories that must never be used as project folders (cross-platform)
const SYSTEM_DIR_RE = /^(System Volume Information|Recovery|PerfLogs|MSOCache|Config\.Msi|Documents and Settings|Boot|Windows|Program Files( \(x86\))?|ProgramData|Intel|AMD|Library|System|Volumes|cores|private|proc|sys|dev|run|boot|lost\+found|snap|mnt|media|tmp|var|etc|usr|bin|sbin|lib|lib32|lib64|libx32|opt|root|srv)$/i;

function validateProjectPath(p) {
  if (!p || typeof p !== 'string') return 'Project path is required';
  if (!path.isAbsolute(p)) return 'Project path must be absolute';
  if (SHELL_METACHAR_RE.test(p)) return 'Project path contains disallowed characters';
  const resolved = path.resolve(p);

  // In single-project mode, accept the configured single project path directly
  if (runtime.mode === 'single-project' && runtime.singleProjectPath) {
    const resolvedSingle = path.resolve(runtime.singleProjectPath);
    if (resolved === resolvedSingle) return null; // valid
  }

  const prefix = resolvedProjectsRoot.endsWith(path.sep) ? resolvedProjectsRoot : resolvedProjectsRoot + path.sep;
  if (resolved !== resolvedProjectsRoot && !resolved.startsWith(prefix)) {
    return 'Project path must be under PROJECTS_ROOT (' + PROJECTS_ROOT + ')';
  }
  // Block system/OS directories — check every segment of the path under PROJECTS_ROOT
  // e.g. R:\..\Windows\System32 resolves to R:\Windows\System32 — "Windows" must be caught
  const relative = resolved.slice(resolvedProjectsRoot.length).replace(/^[/\\]/, '');
  const segments = relative.split(/[/\\]/).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith('.') || seg.startsWith('$') || seg.startsWith('~')) {
      return 'Cannot use hidden or system directory as project folder';
    }
    if (SYSTEM_DIR_RE.test(seg)) {
      return 'Cannot use OS system directory as project folder: ' + seg;
    }
  }
  // Must be exactly one level deep under PROJECTS_ROOT (no nested paths like R:\foo\bar)
  if (segments.length !== 1) {
    return 'Project path must be a direct subfolder of ' + PROJECTS_ROOT;
  }
  return null; // valid
}

// --- Security: Allowed preview commands (C4 fix) ---
const ALLOWED_RUN_RE = /^(pnpm|npm|node)\s/;
function isAllowedRunCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  if (!ALLOWED_RUN_RE.test(cmd)) return false;
  // Block shell metacharacters in run commands — includes quotes that break shell context
  if (/[;&|`$<>!()"'\\]/.test(cmd)) return false;
  return true;
}

// --- Project Detection ---

function detectProject(title) {
  const name = suggestName(title);
  const nameNoHyphens = name.replace(/-/g, '');
  const words = title.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 2; });

  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(function(e) { return e.isDirectory(); })
      .map(function(e) { return e.name; })
      .filter(function(e) { return e !== '$RECYCLE.BIN' && e !== 'System Volume Information'; });
  } catch (_) { return { matches: [], suggestedName: name, meaningfulWords: words }; }

  const matches = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const lower = entry.toLowerCase();
    const lowerNoHyphens = lower.replace(/-/g, '');
    let score = 0;

    if (lower === name || lowerNoHyphens === nameNoHyphens) score = 100;
    else if (lower.includes(name) || name.includes(lower)) score = 80;
    else {
      const matched = words.filter(function(w) { return lower.includes(w); }).length;
      if (words.length > 0 && matched >= Math.ceil(words.length * 0.5)) {
        score = Math.round((matched / words.length) * 60);
      }
    }

    if (score > 0) {
      const fullPath = path.join(PROJECTS_ROOT, entry);
      let fileCount = 0;
      try { fileCount = snapshot.walkDir(fullPath).length; } catch (_) {}
      matches.push({ name: entry, path: fullPath, score: score, files: fileCount });
    }
  }

  matches.sort(function(a, b) { return b.score - a.score; });
  return { matches: matches.slice(0, 8), suggestedName: name, projectsRoot: PROJECTS_ROOT };
}

function analyzeProject(projectPath) {
  const files = snapshot.walkDir(projectPath);
  const analysis = ['Project: ' + path.basename(projectPath)];
  analysis.push('Location: ' + projectPath);
  analysis.push('Files: ' + files.length);
  analysis.push('');
  analysis.push('File tree:');
  const treeFiles = files.slice(0, 100);
  for (let i = 0; i < treeFiles.length; i++) {
    analysis.push('  ' + treeFiles[i]);
  }
  if (files.length > 100) analysis.push('  ... and ' + (files.length - 100) + ' more');

  const keyFiles = ['package.json', 'README.md', 'CLAUDE.md', '.env.example', 'tsconfig.json'];
  for (let k = 0; k < keyFiles.length; k++) {
    const fp = path.join(projectPath, keyFiles[k]);
    if (fs.existsSync(fp)) {
      try {
        const content = fs.readFileSync(fp, 'utf-8');
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
  const card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path assigned');
  const err = validateProjectPath(card.project_path);
  if (err) throw new Error(err);
  const p = card.project_path;
  if (IS_WIN) {
    // `start` brings process to foreground; empty string is required title param
    spawn('cmd', ['/c', 'start', '', 'code', '--new-window', p], { stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    spawn('open', ['-a', 'Visual Studio Code', '--args', '--new-window', p], { stdio: 'ignore' }).unref();
  } else {
    spawn('code', ['--new-window', p], { stdio: 'ignore' }).unref();
  }
}

function openTerminal(cardId) {
  const card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  const err = validateProjectPath(card.project_path);
  if (err) throw new Error(err);
  const p = card.project_path;
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + p + '"'], { detached: true, stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    spawn('open', ['-a', 'Terminal', p], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const child = spawn('gnome-terminal', ['--working-directory=' + p], { detached: true, stdio: 'ignore' });
    child.on('error', function() {
      spawn('xterm', ['-e', 'bash'], { cwd: p, detached: true, stdio: 'ignore' }).unref();
    });
    child.unref();
  }
}

function openClaude(cardId) {
  const card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  const err = validateProjectPath(card.project_path);
  if (err) throw new Error(err);
  const p = card.project_path;
  if (IS_WIN) {
    // Path validated by validateProjectPath — no shell metacharacters possible
    spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + p + '" && set CLAUDECODE= && claude'], { detached: true, stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    const script = "cd '" + p.replace(/'/g, "'\\''") + "' && unset CLAUDECODE && claude";
    spawn('osascript', ['-e', 'tell app "Terminal" to do script "' + script.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const bashCmd = "cd '" + p.replace(/'/g, "'\\''") + "' && unset CLAUDECODE && claude; exec bash";
    const child = spawn('gnome-terminal', ['--', 'bash', '-c', bashCmd], { detached: true, stdio: 'ignore' });
    child.on('error', function() {
      spawn('xterm', ['-e', 'bash', '-c', bashCmd], { detached: true, stdio: 'ignore' }).unref();
    });
    child.unref();
  }
}

// --- Diff Viewer ---

function getDiff(cardId) {
  const snapDir = path.join(DATA_DIR, 'snapshots', 'card-' + cardId);
  const manifestPath = path.join(snapDir, '_manifest.json');
  if (!fs.existsSync(manifestPath)) return { error: 'No snapshot available' };

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const projectPath = manifest.projectPath;

  // Validate manifest path to prevent path traversal via tampered snapshot
  const pathErr = validateProjectPath(projectPath);
  if (pathErr) return { error: 'Invalid project path in snapshot: ' + pathErr };

  if (!fs.existsSync(projectPath)) return { error: 'Project directory not found' };

  const originalFiles = new Set(manifest.files);
  let currentFiles;
  try { currentFiles = new Set(snapshot.walkDir(projectPath)); } catch (_) { currentFiles = new Set(); }

  const diff = { added: [], removed: [], modified: [], unchanged: 0, projectPath: projectPath };

  for (const f of currentFiles) {
    if (!originalFiles.has(f)) {
      const addedPath = path.join(projectPath, f);
      try {
        const buf = fs.readFileSync(addedPath);
        const isText = !buf.includes(0);
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

  // Single pass: classify original files as removed or modified/unchanged
  for (const f of originalFiles) {
    if (!currentFiles.has(f)) {
      diff.removed.push(f);
      continue;
    }
    const origPath = path.join(snapDir, 'files', f);
    const currPath = path.join(projectPath, f);
    try {
      const origBuf = fs.readFileSync(origPath);
      const currBuf = fs.readFileSync(currPath);
      if (!origBuf.equals(currBuf)) {
        const isText = !origBuf.includes(0) && !currBuf.includes(0);
        if (isText) {
          const origText = origBuf.toString('utf-8');
          const currText = currBuf.toString('utf-8');
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
  const card = cards.get(cardId);
  if (!card || !card.project_path) throw new Error('No project path');
  const pathErr = validateProjectPath(card.project_path);
  if (pathErr) throw new Error(pathErr);

  const projectPath = card.project_path;
  const completionFile = path.join(projectPath, '.task-complete');
  let runCommand = null;

  try {
    if (fs.existsSync(completionFile)) {
      const data = JSON.parse(fs.readFileSync(completionFile, 'utf-8'));
      runCommand = data.run_command;
    }
  } catch (_) {}

  if (!runCommand) {
    const pkgPath = path.join(projectPath, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
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

  const fullCmd = 'pnpm install && ' + runCommand;
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', 'cd /d "' + projectPath + '" && ' + fullCmd], { detached: true, stdio: 'ignore' }).unref();
  } else if (IS_MAC) {
    const safeP = projectPath.replace(/'/g, "'\\''");
    spawn('osascript', ['-e', 'tell app "Terminal" to do script "cd \'' + safeP + '\' && ' + fullCmd + '"'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const safeP = projectPath.replace(/'/g, "'\\''");
    spawn('gnome-terminal', ['--', 'bash', '-c', "cd '" + safeP + "' && " + fullCmd + '; exec bash'], { detached: true, stdio: 'ignore' }).unref();
  }

  return { success: true, command: runCommand };
}

// --- Export Board ---

// H3 fix: export only card data by default. Sessions + audit only when opts.full (admin).
function exportBoard(opts) {
  const all = cards.getAll();
  const archived = cards.getArchived();
  const result = {
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
  const all = cards.getAll().concat(cards.getArchived());
  const scores = [];
  const durations = { brainstorm: [], build: [], review: [] };
  const projectCounts = {};
  const completedByDay = {};
  const labelCounts = {};

  for (let i = 0; i < all.length; i++) {
    const card = all[i];

    if (card.project_path) {
      const proj = path.basename(card.project_path);
      projectCounts[proj] = (projectCounts[proj] || 0) + 1;
    }

    if (card.review_score > 0) scores.push(card.review_score);

    if (card.phase_durations) {
      try {
        const pd = JSON.parse(card.phase_durations);
        const phases = ['brainstorm', 'build', 'review'];
        for (let pi = 0; pi < phases.length; pi++) {
          if (pd[phases[pi]] && pd[phases[pi]].duration) durations[phases[pi]].push(pd[phases[pi]].duration);
        }
      } catch (_) {}
    }

    if (card.column_name === 'done' || card.column_name === 'archive') {
      const day = (card.updated_at || '').slice(0, 10);
      if (day) completedByDay[day] = (completedByDay[day] || 0) + 1;
    }

    if (card.labels) {
      const labelArr = card.labels.split(',');
      for (let li = 0; li < labelArr.length; li++) {
        const l = labelArr[li].trim();
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
