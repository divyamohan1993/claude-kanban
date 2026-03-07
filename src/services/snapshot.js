const fs = require('fs');
const path = require('path');
const { SNAPSHOT_ROOT, SNAPSHOT_ARCHIVE } = require('../config');

var SKIP_DIRS = new Set(['node_modules', '.git', '.data', '.pnpm-store']);
var MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function archiveSnapshot(snapDir) {
  if (!fs.existsSync(snapDir)) return;
  var name = path.basename(snapDir);
  var ts = new Date().toISOString().replace(/[:.]/g, '-');
  var archiveDest = path.join(SNAPSHOT_ARCHIVE, name + '-' + ts);
  fs.mkdirSync(SNAPSHOT_ARCHIVE, { recursive: true });
  fs.renameSync(snapDir, archiveDest);
}

function walkDir(dir, base) {
  base = base || dir;
  var files = [];
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return files; }
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (SKIP_DIRS.has(entry.name)) continue;
    var full = path.join(dir, entry.name);
    var rel = path.relative(base, full);
    if (entry.isDirectory()) {
      files = files.concat(walkDir(full, base));
    } else {
      try {
        var stat = fs.statSync(full);
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
  var snapDir = snapshotDir(cardId);
  archiveSnapshot(snapDir);
  fs.mkdirSync(snapDir, { recursive: true });

  var isNew = !fs.existsSync(projectPath);
  var files = isNew ? [] : walkDir(projectPath);

  for (var i = 0; i < files.length; i++) {
    var src = path.join(projectPath, files[i]);
    var dst = path.join(snapDir, 'files', files[i]);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  fs.writeFileSync(path.join(snapDir, '_manifest.json'), JSON.stringify({
    projectPath: projectPath, isNew: isNew, files: files, timestamp: new Date().toISOString(),
  }));

  return { isNew: isNew, fileCount: files.length };
}

function rollback(cardId) {
  var snapDir = snapshotDir(cardId);
  var manifestPath = path.join(snapDir, '_manifest.json');
  if (!fs.existsSync(manifestPath)) return { success: false, reason: 'No snapshot' };

  var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  var projectPath = manifest.projectPath;

  if (manifest.isNew) {
    if (fs.existsSync(projectPath)) fs.rmSync(projectPath, { recursive: true });
  } else {
    var currentFiles = fs.existsSync(projectPath) ? walkDir(projectPath) : [];
    var originalSet = new Set(manifest.files);
    for (var i = 0; i < currentFiles.length; i++) {
      if (!originalSet.has(currentFiles[i])) {
        try { fs.unlinkSync(path.join(projectPath, currentFiles[i])); } catch (_) {}
      }
    }
    cleanEmptyDirs(projectPath);

    for (var j = 0; j < manifest.files.length; j++) {
      var src = path.join(snapDir, 'files', manifest.files[j]);
      var dst = path.join(projectPath, manifest.files[j]);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  }

  archiveSnapshot(snapDir);
  return { success: true, wasNew: manifest.isNew };
}

function revert(cardId) {
  var snapDir = snapshotDir(cardId);
  var manifestPath = path.join(snapDir, '_manifest.json');
  if (!fs.existsSync(manifestPath)) return { success: false, reason: 'No snapshot' };

  var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  var projectPath = manifest.projectPath;

  if (manifest.isNew) {
    if (fs.existsSync(projectPath)) fs.rmSync(projectPath, { recursive: true });
  } else {
    var currentFiles = fs.existsSync(projectPath) ? walkDir(projectPath) : [];
    var originalSet = new Set(manifest.files);
    for (var i = 0; i < currentFiles.length; i++) {
      if (!originalSet.has(currentFiles[i])) {
        try { fs.unlinkSync(path.join(projectPath, currentFiles[i])); } catch (_) {}
      }
    }
    cleanEmptyDirs(projectPath);
    for (var j = 0; j < manifest.files.length; j++) {
      var src = path.join(snapDir, 'files', manifest.files[j]);
      var dst = path.join(projectPath, manifest.files[j]);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  }

  return { success: true, wasNew: manifest.isNew };
}

function clear(cardId) {
  archiveSnapshot(snapshotDir(cardId));
}

function cleanEmptyDirs(dir) {
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (var i = 0; i < entries.length; i++) {
    if (SKIP_DIRS.has(entries[i].name)) continue;
    if (entries[i].isDirectory()) {
      var subDir = path.join(dir, entries[i].name);
      cleanEmptyDirs(subDir);
      try {
        var sub = fs.readdirSync(subDir);
        if (sub.length === 0) fs.rmdirSync(subDir);
      } catch (_) {}
    }
  }
}

function has(cardId) {
  return fs.existsSync(path.join(snapshotDir(cardId), '_manifest.json'));
}

module.exports = { take: take, rollback: rollback, revert: revert, clear: clear, has: has, walkDir: walkDir };
