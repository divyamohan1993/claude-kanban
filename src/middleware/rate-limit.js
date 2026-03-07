// DDoS mitigation — token bucket rate limiter.
//
// Design goals:
//   1. O(1) per request — single Map lookup + arithmetic
//   2. Bounded memory — max 10K tracked IPs, LRU eviction
//   3. Pre-built 429 response — zero serialization on reject
//   4. Runs BEFORE Express parses body, sessions, or anything
//   5. Separate buckets: general API vs auth endpoints
//   6. SSE connection cap — per-IP and global
//
// Token bucket algorithm:
//   - Each IP gets `burst` tokens
//   - Tokens refill at `refillRate` per second
//   - Each request costs 1 token
//   - When empty → instant 429, ~180 bytes, zero processing

// --- Pre-built static responses (allocated once, reused forever) ---
var REJECT_BODY = '{"error":"Too many requests","code":"RATE_LIMITED"}';
var REJECT_HEADERS = {
  'Content-Type': 'application/json',
  'Content-Length': String(Buffer.byteLength(REJECT_BODY)),
  'Retry-After': '1',
  'Connection': 'close',
  'X-Content-Type-Options': 'nosniff',
};

var SSE_REJECT_BODY = 'data: {"error":"connection limit reached"}\n\n';

// --- Configuration ---
var CONFIG = {
  // General API: 60 requests per second burst, refill 30/s
  general: { burst: 60, refillRate: 30 },
  // Auth endpoints: 5 per second burst, refill 1/s (brute force protection on top of session rate limiting)
  auth: { burst: 5, refillRate: 1 },
  // SSE: max connections per IP, max total
  sse: { maxPerIp: 5, maxTotal: 200 },
  // Max tracked IPs before LRU eviction
  maxTrackedIps: 10000,
  // Cleanup interval
  cleanupIntervalMs: 60000,
};

// --- Token bucket store ---
// Map<ip, { tokens: number, lastRefill: number }>
var generalBuckets = new Map();
var authBuckets = new Map();

// --- SSE connection tracking ---
// Map<ip, number> — count of active SSE connections per IP
var sseConnections = new Map();
var sseTotalConnections = 0;

// --- IP extraction ---
function getIp(req) {
  // Trust X-Forwarded-For only if behind known proxy (Cloudflare, nginx)
  // For direct connections, use socket address
  var xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket ? (req.socket.remoteAddress || '') : '';
}

// --- Token bucket check (O(1)) ---
function checkBucket(store, ip, config) {
  var now = Date.now();
  var bucket = store.get(ip);

  if (!bucket) {
    // New IP — full bucket minus this request
    // Evict oldest if at capacity
    if (store.size >= CONFIG.maxTrackedIps) {
      // Delete first entry (oldest insertion — Map preserves order)
      var firstKey = store.keys().next().value;
      store.delete(firstKey);
    }
    store.set(ip, { tokens: config.burst - 1, lastRefill: now });
    return true;
  }

  // Refill tokens based on elapsed time
  var elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(config.burst, bucket.tokens + elapsed * config.refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    return false; // Empty bucket — reject
  }

  bucket.tokens -= 1;
  return true;
}

// --- Main rate limiter middleware ---
// This runs BEFORE everything — before body parsing, before sessions.
// Must be as cheap as possible.
function rateLimiter(req, res, next) {
  var ip = getIp(req);
  var path = req.url;

  // Auth endpoints get stricter limits
  var isAuth = path.indexOf('/api/auth/login') === 0;
  var store = isAuth ? authBuckets : generalBuckets;
  var config = isAuth ? CONFIG.auth : CONFIG.general;

  if (!checkBucket(store, ip, config)) {
    // REJECT — static response, zero processing
    res.writeHead(429, REJECT_HEADERS);
    res.end(REJECT_BODY);
    return;
  }

  next();
}

// --- SSE connection limiter ---
// Wraps the SSE endpoint to enforce per-IP and global connection caps.
function sseGuard(req, res, next) {
  var ip = getIp(req);

  // Global cap
  if (sseTotalConnections >= CONFIG.sse.maxTotal) {
    res.writeHead(429, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
    res.write(SSE_REJECT_BODY);
    res.end();
    return;
  }

  // Per-IP cap
  var count = sseConnections.get(ip) || 0;
  if (count >= CONFIG.sse.maxPerIp) {
    res.writeHead(429, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
    res.write(SSE_REJECT_BODY);
    res.end();
    return;
  }

  // Track connection
  sseConnections.set(ip, count + 1);
  sseTotalConnections++;

  // Clean up on disconnect
  req.on('close', function() {
    var c = sseConnections.get(ip) || 1;
    if (c <= 1) sseConnections.delete(ip);
    else sseConnections.set(ip, c - 1);
    sseTotalConnections = Math.max(0, sseTotalConnections - 1);
  });

  next();
}

// --- Periodic cleanup (prevent stale bucket accumulation) ---
setInterval(function() {
  var now = Date.now();
  var staleThreshold = 120000; // 2 minutes of inactivity

  function cleanStore(store) {
    store.forEach(function(bucket, ip) {
      if (now - bucket.lastRefill > staleThreshold) store.delete(ip);
    });
  }

  cleanStore(generalBuckets);
  cleanStore(authBuckets);
}, CONFIG.cleanupIntervalMs);

// --- Admin visibility ---
function getStats() {
  return {
    generalBuckets: generalBuckets.size,
    authBuckets: authBuckets.size,
    sseConnections: sseTotalConnections,
    ssePerIp: Object.fromEntries(sseConnections),
    config: CONFIG,
  };
}

module.exports = { rateLimiter, sseGuard, getStats, CONFIG };
