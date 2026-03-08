const path = require('path');
const { LOGS_DIR, runtime } = require('../config');

// --- Log Path ---

function logPath(cardId, type) {
  return path.join(LOGS_DIR, 'card-' + cardId + '-' + type + '.log');
}

// --- Name Suggestion ---

const NOISE_WORDS = new Set(['create', 'build', 'make', 'add', 'implement', 'develop', 'write',
  'a', 'an', 'the', 'new', 'project', 'app', 'application', 'website', 'site',
  'for', 'with', 'and', 'or', 'in', 'on', 'to', 'that', 'this', 'my', 'our',
  'feature', 'research', 'improve', 'update', 'fix']);

function suggestName(title) {
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  let meaningful = words.filter(function(w) { return !NOISE_WORDS.has(w) && w.length > 1; });
  if (meaningful.length === 0) meaningful = words.filter(function(w) { return w.length > 1; });
  const name = meaningful.join('-').replace(/[^a-z0-9-]/g, '').replace(/^-|-$/g, '').slice(0, 50);
  return name || 'project';
}

// --- Webhook ---

// M5 fix: block SSRF to internal/metadata IPs
const BLOCKED_HOSTS_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|localhost|::1|\[::1\])$/i;

function isBlockedWebhookUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return BLOCKED_HOSTS_RE.test(url.hostname);
  } catch (_) { return true; }
}

function sendWebhook(event, data) {
  if (!runtime.webhookUrl) return;
  if (isBlockedWebhookUrl(runtime.webhookUrl)) return;
  try {
    const mod = runtime.webhookUrl.startsWith('https') ? require('https') : require('http');
    const url = new URL(runtime.webhookUrl);
    const payload = JSON.stringify({ event: event, data: data, timestamp: new Date().toISOString() });
    const req = mod.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, function() {});
    req.on('error', function() {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

module.exports = { logPath, suggestName, sendWebhook, isBlockedWebhookUrl };
