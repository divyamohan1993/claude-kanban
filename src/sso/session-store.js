// Server-side session store — owned by the SSO module.
//
// Security:
//   - 256-bit random session IDs
//   - HttpOnly + SameSite=Strict cookies
//   - Fingerprint binding (IP + User-Agent)
//   - Exponential backoff rate limiting (3 fails → 1s, cap 1hr, 10 = permanent)
//   - Session rotation on login
//   - 24-hour expiry

const crypto = require('crypto');
const { runtime } = require('../config');

const COOKIE_NAME = 'sid';

const store = new Map();
const loginAttempts = new Map();

function generateId() { return crypto.randomBytes(32).toString('hex'); }

function fingerprint(req) {
  const ip = req.ip || req.socket.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';
  const lang = req.headers['accept-language'] || '';
  const enc = req.headers['accept-encoding'] || '';
  return crypto.createHash('sha256').update(ip + '|' + ua + '|' + lang + '|' + enc).digest('hex');
}

function create(user, req) {
  if (store.size >= runtime.maxSessions) {
    let oldest = null, oldestId = null;
    store.forEach(function(s, id) {
      if (!oldest || s.createdAt < oldest) { oldest = s.createdAt; oldestId = id; }
    });
    if (oldestId) store.delete(oldestId);
  }
  const id = generateId();
  store.set(id, {
    user: user,
    fingerprint: req ? fingerprint(req) : '',
    ip: req ? (req.ip || req.socket.remoteAddress || '') : '',
    createdAt: Date.now(),
    lastAccess: Date.now(),
  });
  return id;
}

function get(id, req) {
  if (!id) return null;
  const s = store.get(id);
  if (!s) return null;
  if (Date.now() - s.createdAt > runtime.sessionMaxAgeMins * 60 * 1000) { store.delete(id); return null; }
  if (req && s.fingerprint && s.fingerprint !== fingerprint(req)) { store.delete(id); return null; }
  s.lastAccess = Date.now();
  return s;
}

function destroy(id) { if (id) store.delete(id); }

// O(n) string parsing — no regex, no ReDoS risk from crafted cookie headers
function parseId(cookieHeader) {
  if (!cookieHeader) return null;
  const prefix = COOKIE_NAME + '=';
  const parts = cookieHeader.split(';');
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i].trim();
    if (c.substring(0, prefix.length) === prefix) {
      return c.substring(prefix.length);
    }
  }
  return null;
}

function setCookie(res, sessionId) {
  const secure = (process.env.SECURE_COOKIES === 'true' || process.env.NODE_ENV === 'production') ? '; Secure' : '';
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + sessionId + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.floor(runtime.sessionMaxAgeMins * 60) + secure);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

// Rate limiting
function rateLimitKey(ip, req) {
  const ua = (req && req.headers) ? (req.headers['user-agent'] || '') : '';
  return ip + '|' + ua;
}

function checkRateLimit(ip, req) {
  const key = rateLimitKey(ip, req);
  const record = loginAttempts.get(key);
  if (!record) return { allowed: true };
  if (record.permanentLock) return { allowed: false, permanent: true, retryAfter: Infinity };
  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((record.lockedUntil - Date.now()) / 1000) };
  }
  return { allowed: true };
}

function recordFailedLogin(ip, req) {
  const key = rateLimitKey(ip, req);
  const record = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  record.count++;
  record.lastAttempt = Date.now();
  if (record.count >= 10) record.permanentLock = true;
  else if (record.count >= 3) {
    record.lockedUntil = Date.now() + Math.min(Math.pow(2, record.count - 3) * 1000, 3600000);
  }
  loginAttempts.set(key, record);
  return record;
}

function recordSuccessfulLogin(ip, req) {
  loginAttempts.delete(rateLimitKey(ip, req));
}

// Cleanup every hour
setInterval(function() {
  const now = Date.now();
  store.forEach(function(s, id) { if (now - s.createdAt > runtime.sessionMaxAgeMins * 60 * 1000) store.delete(id); });
  loginAttempts.forEach(function(r, key) {
    if (!r.permanentLock && r.lastAttempt && now - r.lastAttempt > 7200000) loginAttempts.delete(key);
  });
}, 3600000);

module.exports = {
  create: create, get: get, destroy: destroy,
  parseId: parseId, setCookie: setCookie, clearCookie: clearCookie,
  checkRateLimit: checkRateLimit, recordFailedLogin: recordFailedLogin,
  recordSuccessfulLogin: recordSuccessfulLogin,
};
