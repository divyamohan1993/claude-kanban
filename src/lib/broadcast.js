// SSE broadcast singleton — shared across all services.
// Replaces the old _broadcast callback pattern.

const sseClients = new Set();
const adminClients = new Set();

// Lazy-loaded enrichCard — avoids circular dependency at require time.
// Set by server.js after routes are loaded.
let _enrichCard = null;

function broadcast(event, data) {
  // Auto-enrich card events so services don't need to call enrichCard manually
  if (_enrichCard && data && data.id && event.startsWith('card-') && !data.actions) {
    _enrichCard(data);
  }
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of sseClients) c.write(msg);
  for (const c of adminClients) c.write(msg);
}

function setEnrichCard(fn) { _enrichCard = fn; }

module.exports = { broadcast, sseClients, adminClients, setEnrichCard };
