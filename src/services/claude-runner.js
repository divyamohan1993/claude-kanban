const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { IS_WIN, RUNTIME_DIR, runtime } = require('../config');
const { usage } = require('../db');

// Spawn Claude CLI silently via .bat/.sh wrapper.
// Returns { pid, scriptPath }. Caller is responsible for PID tracking.
function runClaudeSilent(opts) {
  var scriptPath, lines;
  var cliBase = 'claude --model ' + runtime.claudeModel + ' --effort ' + runtime.claudeEffort + ' --dangerously-skip-permissions';

  if (IS_WIN) {
    scriptPath = path.join(RUNTIME_DIR, '.run-' + opts.id + '.bat');
    var escapedPrompt = opts.prompt.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
    lines = [
      '@echo off',
      'cd /d "' + opts.cwd + '"',
      'set CLAUDECODE=',
    ];
    if (opts.stdoutFile) {
      lines.push(cliBase + ' -p "' + escapedPrompt + '" > "' + opts.stdoutFile + '" 2>> "' + opts.logFile + '"');
    } else {
      lines.push(cliBase + ' -p "' + escapedPrompt + '" >> "' + opts.logFile + '" 2>&1');
    }
    fs.writeFileSync(scriptPath, lines.join('\r\n'));
  } else {
    scriptPath = path.join(RUNTIME_DIR, '.run-' + opts.id + '.sh');
    var escapedPrompt = opts.prompt.replace(/'/g, "'\\''").replace(/[\r\n]+/g, ' ');
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

  var child = spawn(IS_WIN ? 'cmd' : 'bash', IS_WIN ? ['/c', scriptPath] : [scriptPath], {
    cwd: opts.cwd,
    stdio: 'ignore',
    windowsHide: true,
    detached: !IS_WIN,
  });
  child.unref();

  var pid = child.pid || 0;

  // Track usage for limit enforcement
  var usageType = (opts.id || '').replace(/-\d+.*$/, '');
  usage.log(usageType, opts.cardId || null);

  return { pid: pid, scriptPath: scriptPath };
}

module.exports = { runClaudeSilent: runClaudeSilent };
