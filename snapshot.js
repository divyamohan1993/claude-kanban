const fs = require('fs');
const path = require('path');

const SNAPSHOT_ROOT = path.join(__dirname, '.snapshots');
const SKIP_DIRS = new Set(['node_modules', '.git', '.snapshots', '.pnpm-store']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function walkDir(dir, base) {
  base = base || dir;
  let files = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return files; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      files = files.concat(walkDir(full, base));
    } else {
      try {
        const stat = fs.statSync(full);
        if (stat.size <= MAX_FILE_SIZE) files.push(rel);
      } catch (_) {}
    }
  }
  return files;
}

function snapshotDir(cardId) {
  return path.join(SNAPSHOT_ROOT, 'card-' + cardId);
}

function take(cardId, projectPath) {
  const snapDir = snapshotDir(cardId);
  if (fs.existsSync(snapDir)) fs.rmSync(snapDir, { recursive: true });
  fs.mkdirSync(snapDir, { recursive: true });

  const isNew = !fs.existsSync(projectPath);
  const files = isNew ? [] : walkDir(projectPath);

  for (const rel of files) {
    const src = path.join(projectPath, rel);
    const dst = path.join(snapDir, 'files', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  fs.writeFileSync(path.join(snapDir, '_manifest.json'), JSON.stringify({
    projectPath, isNew, files, timestamp: new Date().toISOString(),
  }));

  return { isNew, fileCount: files.length };
}

function rollback(cardId) {
  const snapDir = snapshotDir(cardId);
  const manifestPath = path.join(snapDir, '_manifest.json');
  if (!fs.existsSync(manifestPath)) return { success: false, reason: 'No snapshot' };

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const projectPath = manifest.projectPath;

  if (manifest.isNew) {
    // Project didn't exist before work started — remove entirely
    if (fs.existsSync(projectPath)) fs.rmSync(projectPath, { recursive: true });
  } else {
    // Remove files that were added during work
    const currentFiles = fs.existsSync(projectPath) ? walkDir(projectPath) : [];
    const originalSet = new Set(manifest.files);
    for (const rel of currentFiles) {
      if (!originalSet.has(rel)) {
        const fp = path.join(projectPath, rel);
        try { fs.unlinkSync(fp); } catch (_) {}
      }
    }
    // Clean empty directories
    cleanEmptyDirs(projectPath);

    // Restore original files
    for (const rel of manifest.files) {
      const src = path.join(snapDir, 'files', rel);
      const dst = path.join(projectPath, rel);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  }

  fs.rmSync(snapDir, { recursive: true });
  return { success: true, wasNew: manifest.isNew };
}

function clear(cardId) {
  const snapDir = snapshotDir(cardId);
  if (fs.existsSync(snapDir)) fs.rmSync(snapDir, { recursive: true });
}

function cleanEmptyDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      cleanEmptyDirs(path.join(dir, entry.name));
      try {
        const sub = fs.readdirSync(path.join(dir, entry.name));
        if (sub.length === 0) fs.rmdirSync(path.join(dir, entry.name));
      } catch (_) {}
    }
  }
}

module.exports = { take, rollback, clear, walkDir };
