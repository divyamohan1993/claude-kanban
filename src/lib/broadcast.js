// SSE broadcast singleton — shared across all services.
// Replaces the old _broadcast callback pattern.

const sseClients = new Set();
const adminClients = new Set();

function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of sseClients) c.write(msg);
  for (const c of adminClients) c.write(msg);
}

module.exports = { broadcast, sseClients, adminClients };
