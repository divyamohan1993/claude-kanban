const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { IS_WIN, RUNTIME_DIR, runtime } = require('../config');
const { usage } = require('../db');

// Allowlists for CLI arguments — prevents environment injection
const ALLOWED_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20241022', 'claude-sonnet-4-20250514'];
const ALLOWED_EFFORTS = ['low', 'medium', 'high', 'max'];

function sanitizeModel(m) { return ALLOWED_MODELS.includes(m) ? m : 'claude-sonnet-4-6'; }
function sanitizeEffort(e) { return ALLOWED_EFFORTS.includes(e) ? e : 'high'; }

// Strip null bytes and non-printable control chars (except newlines/tabs) from file content
function sanitizeForFile(s) { return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); }

// Spawn Claude CLI silently via .bat/.sh wrapper.
// Returns { pid, scriptPath }. Caller is responsible for PID tracking.
function runClaudeSilent(opts) {
  let scriptPath, lines;
  const model = sanitizeModel(runtime.claudeModel);
  const effort = sanitizeEffort(runtime.claudeEffort);
  const cliBase = 'claude --model ' + model + ' --effort ' + effort + ' --dangerously-skip-permissions';
  const safePrompt = sanitizeForFile(opts.prompt);

  if (IS_WIN) {
    scriptPath = path.join(RUNTIME_DIR, '.run-' + opts.id + '.bat');
    // C6 fix: write prompt to temp file to avoid ALL bat metachar injection (%,^,&,|,!,<,>)
    const promptFile = path.join(RUNTIME_DIR, '.prompt-' + opts.id + '.txt');
    fs.writeFileSync(promptFile, safePrompt);
    lines = [
      '@echo off',
      'cd /d "' + opts.cwd + '"',
      'set CLAUDECODE=',
    ];
    if (opts.stdoutFile) {
      lines.push('type "' + promptFile + '" | ' + cliBase + ' > "' + opts.stdoutFile + '" 2>> "' + opts.logFile + '"');
    } else {
      lines.push('type "' + promptFile + '" | ' + cliBase + ' >> "' + opts.logFile + '" 2>&1');
    }
    fs.writeFileSync(scriptPath, lines.join('\r\n'));
  } else {
    scriptPath = path.join(RUNTIME_DIR, '.run-' + opts.id + '.sh');
    const escapedPrompt = safePrompt.replace(/'/g, "'\\''").replace(/[\r\n]+/g, ' ');
    lines = [
      '#!/bin/bash',
      'cd "' + opts.cwd + '"',
      'unset CLAUDECODE',
    ];
    if (opts.stdoutFile) {
      lines.push(cliBase + " -p '" + escapedPrompt + "' 2>> '" + opts.logFile + "' | tee '" + opts.stdoutFile + "' >> '" + opts.logFile + "'");
    } else {
      lines.push(cliBase + " -p '" + escapedPrompt + "' >> '" + opts.logFile + "' 2>&1");
    }
    fs.writeFileSync(scriptPath, lines.join('\n'), { mode: 0o755 });
  }

  const child = spawn(IS_WIN ? 'cmd' : 'bash', IS_WIN ? ['/c', scriptPath] : [scriptPath], {
    cwd: opts.cwd,
    stdio: 'ignore',
    windowsHide: true,
    detached: !IS_WIN,
  });
  child.unref();

  const pid = child.pid || 0;

  // Track usage for limit enforcement
  const usageType = (opts.id || '').replace(/-\d+.*$/, '');
  usage.log(usageType, opts.cardId || null);

  return { pid: pid, scriptPath: scriptPath };
}

// --- Rate-Limit Detection ---
// Reads the tail of a log file and checks for CLI rate-limit error patterns.
// Returns { detected: boolean, pattern?: string } to distinguish from normal timeouts.
const RATE_LIMIT_PATTERNS = [
  /rate[_\s-]?limit/i,
  /too many requests/i,
  /quota[_\s-]?exceeded/i,
  /usage[_\s-]?limit/i,
  /overloaded/i,
  /try again later/i,
  /max.*usage.*reached/i,
  /exceeded.*(?:rate|usage|token).*limit/i,
  /HTTP[\/\s]*429/i,
  /status[:\s]*429/i,
  /capacity.*exceeded/i,
  /request.*throttled/i,
];

function detectRateLimit(logFile) {
  let fd;
  try {
    fd = fs.openSync(logFile, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) { fs.closeSync(fd); return { detected: false }; }
    const readSize = Math.min(stat.size, 4000);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    fd = null;
    const tail = buf.toString('utf-8');
    for (let i = 0; i < RATE_LIMIT_PATTERNS.length; i++) {
      if (RATE_LIMIT_PATTERNS[i].test(tail)) {
        return { detected: true, pattern: RATE_LIMIT_PATTERNS[i].source };
      }
    }
  } catch (_) {
    if (fd) try { fs.closeSync(fd); } catch (_e) {}
  }
  return { detected: false };
}

module.exports = { runClaudeSilent: runClaudeSilent, detectRateLimit: detectRateLimit, sanitizeForFile: sanitizeForFile };
