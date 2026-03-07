const path = require('path');
const { LOGS_DIR, runtime } = require('../config');

// --- Log Path ---

function logPath(cardId, type) {
  return path.join(LOGS_DIR, 'card-' + cardId + '-' + type + '.log');
}

// --- Name Suggestion ---

var NOISE_WORDS = new Set(['create', 'build', 'make', 'add', 'implement', 'develop', 'write',
  'a', 'an', 'the', 'new', 'project', 'app', 'application', 'website', 'site',
  'for', 'with', 'and', 'or', 'in', 'on', 'to', 'that', 'this', 'my', 'our',
  'feature', 'research', 'improve', 'update', 'fix']);

function suggestName(title) {
  var words = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  var meaningful = words.filter(function(w) { return !NOISE_WORDS.has(w) && w.length > 1; });
  if (meaningful.length === 0) meaningful = words.filter(function(w) { return w.length > 1; });
  var name = meaningful.join('-').replace(/[^a-z0-9-]/g, '').replace(/^-|-$/g, '').slice(0, 50);
  return name || 'project';
}

// --- Webhook ---

function sendWebhook(event, data) {
  if (!runtime.webhookUrl) return;
  try {
    var mod = runtime.webhookUrl.startsWith('https') ? require('https') : require('http');
    var url = new URL(runtime.webhookUrl);
    var payload = JSON.stringify({ event: event, data: data, timestamp: new Date().toISOString() });
    var req = mod.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, function() {});
    req.on('error', function() {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

module.exports = { logPath, suggestName, sendWebhook };
