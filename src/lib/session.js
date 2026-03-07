// Server-side session store — zero-trust, defense-in-depth.
//
// Security layers:
//   1. Session ID: 256-bit cryptographic random (unguessable)
//   2. HttpOnly + SameSite=Strict cookie (JS can't read, cross-site can't send)
//   3. Fingerprint binding: session tied to IP + User-Agent hash
//      → Stolen cookie from different machine/browser = instant invalidation
//   4. Rate limiting: exponential backoff on failed logins
//      → 3 fails = 1s lock, 4 = 2s, 5 = 4s, ... cap 1hr. 10 fails = permanent lockout
//   5. Session rotation: new session ID on every login (prevents fixation)
//   6. Frontend never sees tokens — browser handles cookie automatically

var crypto = require('crypto');

var COOKIE_NAME = 'sid';
var MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
var MAX_AGE_S = Math.floor(MAX_AGE_MS / 1000);
var MAX_SESSIONS = 10000; // H5 fix: cap session store to prevent OOM

var store = new Map();
var loginAttempts = new Map(); // ip -> { count, lastAttempt, lockedUntil, permanentLock }

// =============================================================================
// SESSION CORE
// =============================================================================

function generateId() {
  return crypto.randomBytes(32).toString('hex');
}

// Client fingerprint — binds session to specific machine + browser
// L4 fix: include Accept-Language and Accept-Encoding for stronger binding
function fingerprint(req) {
  var ip = req.ip || req.socket.remoteAddress || '';
  var ua = req.headers['user-agent'] || '';
  var lang = req.headers['accept-language'] || '';
  var enc = req.headers['accept-encoding'] || '';
  return crypto.createHash('sha256').update(ip + '|' + ua + '|' + lang + '|' + enc).digest('hex');
}

function create(user, req) {
  // H5 fix: evict oldest sessions when store is at capacity
  if (store.size >= MAX_SESSIONS) {
    var oldest = null, oldestId = null;
    store.forEach(function(s, id) {
      if (!oldest || s.createdAt < oldest) { oldest = s.createdAt; oldestId = id; }
    });
    if (oldestId) store.delete(oldestId);
  }
  var id = generateId();
  var fp = req ? fingerprint(req) : '';
  var ip = req ? (req.ip || req.socket.remoteAddress || '') : '';
  store.set(id, {
    user: user,
    fingerprint: fp,
    ip: ip,
    createdAt: Date.now(),
    lastAccess: Date.now(),
  });
  return id;
}

function get(id, req) {
  if (!id) return null;
  var s = store.get(id);
  if (!s) return null;

  // Expired?
  if (Date.now() - s.createdAt > MAX_AGE_MS) {
    store.delete(id);
    return null;
  }

  // Fingerprint mismatch = stolen cookie → destroy immediately
  if (req && s.fingerprint && s.fingerprint !== fingerprint(req)) {
    store.delete(id);
    return null;
  }

  s.lastAccess = Date.now();
  return s;
}

function destroy(id) {
  if (id) store.delete(id);
}

// Destroy all sessions for a user (e.g., on password change or forced logout)
function destroyAll(userId) {
  store.forEach(function(s, id) {
    if (s.user.id === userId) store.delete(id);
  });
}

// =============================================================================
// COOKIE MANAGEMENT
// =============================================================================

function parseId(cookieHeader) {
  if (!cookieHeader) return null;
  var match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
  return match ? match[1] : null;
}

function setCookie(res, sessionId) {
  // M3 fix: add Secure flag when behind HTTPS proxy
  var secure = (process.env.SECURE_COOKIES === 'true' || process.env.NODE_ENV === 'production') ? '; Secure' : '';
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + sessionId + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + MAX_AGE_S + secure);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

// =============================================================================
// RATE LIMITING — exponential backoff + permanent lockout
// =============================================================================

// M8 fix: rate limit keyed on IP + User-Agent fingerprint to avoid localhost shared-IP lockout
function rateLimitKey(ip, req) {
  if (!req) return ip;
  var ua = req.headers ? (req.headers['user-agent'] || '') : '';
  return ip + '|' + ua;
}

function checkRateLimit(ip, req) {
  var key = rateLimitKey(ip, req);
  var record = loginAttempts.get(key);
  if (!record) return { allowed: true };
  if (record.permanentLock) {
    return { allowed: false, permanent: true, retryAfter: Infinity };
  }
  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((record.lockedUntil - Date.now()) / 1000) };
  }
  return { allowed: true };
}

function recordFailedLogin(ip, req) {
  var key = rateLimitKey(ip, req);
  var record = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  record.count++;
  record.lastAttempt = Date.now();

  if (record.count >= 10) {
    // Permanent lockout — server restart required to unlock
    record.permanentLock = true;
  } else if (record.count >= 3) {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s, cap 1hr
    var lockMs = Math.min(Math.pow(2, record.count - 3) * 1000, 3600000);
    record.lockedUntil = Date.now() + lockMs;
  }

  loginAttempts.set(key, record);
  return record;
}

function recordSuccessfulLogin(ip, req) {
  var key = rateLimitKey(ip, req);
  loginAttempts.delete(key);
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

function requireAuth(req, res, next) {
  var sid = parseId(req.headers.cookie);
  var s = get(sid, req); // fingerprint validated
  if (!s) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  req.user = s.user;
  next();
}

function requireAdmin(req, res, next) {
  var sid = parseId(req.headers.cookie);
  var s = get(sid, req); // fingerprint validated
  if (!s) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (s.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'FORBIDDEN' });
  }
  req.user = s.user;
  next();
}

// =============================================================================
// ADMIN VISIBILITY
// =============================================================================

function getActiveSessions() {
  var now = Date.now();
  var active = [];
  store.forEach(function(s, id) {
    if (now - s.createdAt <= MAX_AGE_MS) {
      active.push({
        id: id.slice(0, 8) + '...',
        user: s.user.name,
        ip: s.ip,
        created: new Date(s.createdAt).toISOString(),
        lastAccess: new Date(s.lastAccess).toISOString(),
      });
    }
  });
  return active;
}

function getRateLimitStatus() {
  var entries = [];
  loginAttempts.forEach(function(r, ip) {
    entries.push({
      ip: ip,
      attempts: r.count,
      permanent: !!r.permanentLock,
      lockedUntil: r.lockedUntil ? new Date(r.lockedUntil).toISOString() : null,
    });
  });
  return entries;
}

// =============================================================================
// CLEANUP
// =============================================================================

setInterval(function() {
  var now = Date.now();
  store.forEach(function(s, id) {
    if (now - s.createdAt > MAX_AGE_MS) store.delete(id);
  });
  // Clean old rate limit records (non-permanent, older than 2 hours)
  loginAttempts.forEach(function(r, ip) {
    if (!r.permanentLock && r.lastAttempt && now - r.lastAttempt > 7200000) {
      loginAttempts.delete(ip);
    }
  });
}, 3600000);

module.exports = {
  create: create,
  get: get,
  destroy: destroy,
  destroyAll: destroyAll,
  parseId: parseId,
  setCookie: setCookie,
  clearCookie: clearCookie,
  requireAuth: requireAuth,
  requireAdmin: requireAdmin,
  checkRateLimit: checkRateLimit,
  recordFailedLogin: recordFailedLogin,
  recordSuccessfulLogin: recordSuccessfulLogin,
  getActiveSessions: getActiveSessions,
  getRateLimitStatus: getRateLimitStatus,
  fingerprint: fingerprint,
  COOKIE_NAME: COOKIE_NAME,
};
