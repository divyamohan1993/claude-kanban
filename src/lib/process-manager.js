const { spawn } = require('child_process');
const { IS_WIN } = require('../config');

function killProcess(pid) {
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (_) {
    try { process.kill(pid, 'SIGKILL'); } catch (_2) {}
  }
}

module.exports = { killProcess };
