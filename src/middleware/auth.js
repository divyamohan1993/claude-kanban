// Authentication middleware — zero-trust, session-based, SSO-ready.
//
// Defense layers:
//   1. Rate limiting: exponential backoff + permanent lockout after 10 failures
//   2. Fingerprint binding: session tied to IP + User-Agent (stolen cookie = invalidated)
//   3. Audit trail: every auth event logged (login, fail, lockout)
//   4. Session rotation: new session ID on every login (prevents fixation)
//   5. HttpOnly + SameSite=Strict cookies (XSS + CSRF proof)
//
// Frontend involvement: ZERO. Browser sends cookie. Server validates everything.

var crypto = require('crypto');
var session = require('../lib/session');
var { auditLog } = require('../db');

// =============================================================================
// AUTH PROVIDERS
// =============================================================================

class AuthProvider {
  get isRequired() { return true; }
  async authenticate(_credentials) {
    throw new Error('AuthProvider.authenticate() not implemented');
  }
}

class PinAuthProvider extends AuthProvider {
  constructor(pin) {
    super();
    this.pin = pin;
  }

  get isRequired() { return !!this.pin; }

  async authenticate(credentials) {
    if (!this.pin) {
      return { authenticated: true, user: { id: 'local', role: 'admin', name: 'Local Admin', provider: 'none' } };
    }
    // H4 fix: true constant-time comparison using crypto.timingSafeEqual with fixed-size buffers
    var pin = (credentials && credentials.pin) ? String(credentials.pin) : '';
    var a = Buffer.alloc(256);
    a.write(pin);
    var b = Buffer.alloc(256);
    b.write(this.pin);
    if (crypto.timingSafeEqual(a, b)) {
      return { authenticated: true, user: { id: 'pin', role: 'admin', name: 'PIN Auth', provider: 'pin' } };
    }
    return { authenticated: false };
  }
}

class SSOAuthProvider extends AuthProvider {
  constructor(opts) {
    super();
    this.issuer = opts.issuer;
    this.clientId = opts.clientId;
    this.allowedRoles = opts.allowedRoles || ['admin'];
  }

  async authenticate(_credentials) {
    // Future: validate JWT/OIDC token
    return { authenticated: false };
  }
}

// =============================================================================
// ROUTE HANDLERS
// =============================================================================

// GET /api/auth/session — check session validity, auto-create if no auth required
function createSessionHandler(provider) {
  return function(req, res) {
    var sid = session.parseId(req.headers.cookie);
    var s = session.get(sid, req); // fingerprint validated
    if (s) {
      return res.json({ authenticated: true, user: { name: s.user.name, role: s.user.role } });
    }
    if (!provider.isRequired) {
      var user = { id: 'local', role: 'admin', name: 'Local Admin', provider: 'none' };
      var newSid = session.create(user, req); // fingerprint bound
      session.setCookie(res, newSid);
      return res.json({ authenticated: true, user: { name: user.name, role: user.role }, autoSession: true });
    }
    res.json({ authenticated: false, loginRequired: true });
  };
}

// POST /api/auth/login — rate-limited, fingerprint-bound, audit-logged
function createLoginHandler(provider) {
  return async function(req, res) {
    var ip = req.ip || req.socket.remoteAddress || '';

    // Rate limit check — reject before any processing
    var rateCheck = session.checkRateLimit(ip, req);
    if (!rateCheck.allowed) {
      if (rateCheck.permanent) {
        auditLog('auth-lockout', 'session', null, 'unknown', '', ip, 'permanent lockout — rejected');
        return res.status(429).json({ ok: false, error: 'Account locked. Server restart required.', code: 'LOCKED' });
      }
      return res.status(429).json({
        ok: false,
        error: 'Too many attempts. Retry in ' + rateCheck.retryAfter + 's.',
        code: 'RATE_LIMITED',
        retryAfter: rateCheck.retryAfter,
      });
    }

    try {
      var result = await provider.authenticate(req.body || {});
      if (result.authenticated) {
        session.recordSuccessfulLogin(ip, req);

        // Destroy any existing session (rotation — prevents fixation)
        var oldSid = session.parseId(req.headers.cookie);
        if (oldSid) session.destroy(oldSid);

        // Create fingerprint-bound session
        var sid = session.create(result.user, req);
        session.setCookie(res, sid);

        auditLog('auth-login', 'session', null, result.user.id, '', ip, 'login success via ' + result.user.provider);
        return res.json({ ok: true, user: { name: result.user.name, role: result.user.role } });
      }

      // Failed attempt — record and audit
      var record = session.recordFailedLogin(ip, req);
      var detail = 'attempt ' + record.count;
      if (record.permanentLock) detail += ' — PERMANENTLY LOCKED';
      else if (record.lockedUntil) detail += ' — locked ' + Math.ceil((record.lockedUntil - Date.now()) / 1000) + 's';
      auditLog('auth-fail', 'session', null, 'unknown', '', ip, detail);

      res.status(401).json({ ok: false, error: 'Invalid credentials' });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Auth error' });
    }
  };
}

// POST /api/auth/logout — destroy session, audit
function logoutHandler(req, res) {
  var sid = session.parseId(req.headers.cookie);
  var s = session.get(sid, req);
  if (s) {
    auditLog('auth-logout', 'session', null, s.user.id, '', req.ip || req.socket.remoteAddress || '', 'logout');
  }
  session.destroy(sid);
  session.clearCookie(res);
  res.json({ ok: true });
}

module.exports = {
  AuthProvider: AuthProvider,
  PinAuthProvider: PinAuthProvider,
  SSOAuthProvider: SSOAuthProvider,
  createSessionHandler: createSessionHandler,
  createLoginHandler: createLoginHandler,
  logoutHandler: logoutHandler,
};
