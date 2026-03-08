// =============================================================================
// SSO Identity Provider — Isolated, Self-Contained, Enterprise-Pattern
// =============================================================================
//
// This module is the SOLE identity authority. It owns:
//   - Login page UI (GET /auth/login)
//   - Authentication endpoint (POST /auth/login)
//   - Logout endpoint (POST /auth/logout)
//   - Session check (GET /auth/session)
//   - JWT token issuance (OIDC-standard claims: sub, name, role, email, groups)
//   - JWT cryptographic verification (HS256)
//   - User store + credential validation
//
// The consuming application mounts this module's routes and uses exported
// middleware. It NEVER handles login UI, credentials, or tokens directly.
// The server receives only verified identity claims via req.user.
//
// To replace with real OIDC/SAML:
//   1. Delete this folder (src/sso/)
//   2. Create a new module exporting the same interface:
//      - routes: Express router handling /auth/*
//      - optionalAuth(req, res, next): sets req.user if valid, never rejects
//      - requireAuth(req, res, next): rejects 401 if not authenticated
//      - requireAdmin(req, res, next): rejects 403 if not admin
//      - verifySession(req): returns { user } or null
//   3. Mount routes, use middleware — zero changes to kanban code.
// =============================================================================

const path = require('path');
const express = require('express');
const users = require('./users');
const jwt = require('./jwt');
const sessionStore = require('./session-store');

const router = express.Router();

// Token lifetime — matches session TTL (24 hours)
const TOKEN_TTL_SEC = 24 * 60 * 60;

// =============================================================================
// INTERNAL: Verify session + JWT token, return validated claims or null.
// This is the ONLY place identity is resolved for middleware.
// Session lookup → JWT cryptographic verification → validated claims.
// =============================================================================
function resolveIdentity(req) {
  const sid = sessionStore.parseId(req.headers.cookie);
  const s = sessionStore.get(sid, req);
  if (!s || !s.user || !s.user.token) return null;

  // Cryptographically verify the JWT — don't trust session data alone
  const claims = jwt.verify(s.user.token);
  if (!claims) {
    // Token invalid/expired — destroy the session
    sessionStore.destroy(sid);
    return null;
  }

  return claims;
}

// =============================================================================
// ROUTES — SSO owns all /auth/* endpoints
// =============================================================================

// --- Login page (served by SSO, not by the application) ---
// Validate return URL — must be a relative path (starts with / but not //).
// Prevents open redirect to external sites via //evil.com or javascript: URIs.
function safeReturnUrl(raw) {
  if (!raw || typeof raw !== 'string') return '/';
  // Must start with / and not be protocol-relative (//) or contain dangerous schemes
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return '/';
  return raw;
}

router.get('/auth/login', function(req, res) {
  const claims = resolveIdentity(req);
  if (claims) {
    return res.redirect(safeReturnUrl(req.query.return));
  }
  let html = require('fs').readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf-8');
  const nonce = res.locals.cspNonce || '';
  if (nonce) html = html.replace('<script>', '<script nonce="' + nonce + '">');
  res.type('html').send(html);
});

// --- Authentication endpoint ---
// Validates credentials → issues JWT with OIDC-standard claims → creates session
router.post('/auth/login', async function(req, res) {
  const ip = req.ip || req.socket.remoteAddress || '';

  // Rate limit — reject before any processing
  const rateCheck = sessionStore.checkRateLimit(ip, req);
  if (!rateCheck.allowed) {
    if (rateCheck.permanent) {
      return res.status(429).json({ ok: false, error: 'Account locked. Server restart required.', code: 'LOCKED' });
    }
    return res.status(429).json({ ok: false, error: 'Too many attempts. Retry in ' + rateCheck.retryAfter + 's.', code: 'RATE_LIMITED' });
  }

  const body = req.body || {};
  const user = await users.authenticate(String(body.username || ''), String(body.password || ''));

  if (user) {
    const userInfo = users.toUserInfo(user);
    sessionStore.recordSuccessfulLogin(ip, req);

    // Rotate session — destroy any existing session
    const oldSid = sessionStore.parseId(req.headers.cookie);
    if (oldSid) sessionStore.destroy(oldSid);

    // Issue JWT with OIDC-standard claims
    const token = jwt.sign({
      sub: userInfo.sub,
      name: userInfo.name,
      email: userInfo.email,
      role: userInfo.role,
      groups: userInfo.groups,
      aud: 'claude-kanban',
    }, TOKEN_TTL_SEC);

    // Session stores the JWT — server middleware will verify it cryptographically
    const sid = sessionStore.create({ token: token }, req);
    sessionStore.setCookie(res, sid);

    // Return only the public identity — no token exposed to frontend
    return res.json({ ok: true, user: { name: userInfo.name, role: userInfo.role } });
  }

  // Failed attempt
  sessionStore.recordFailedLogin(ip, req);
  res.status(401).json({ ok: false, error: 'Invalid credentials' });
});

// --- Session check ---
// Returns verified identity claims if session + JWT are valid
router.get('/auth/session', function(req, res) {
  const claims = resolveIdentity(req);
  if (claims) {
    const payload = { authenticated: true, user: { name: claims.name, role: claims.role } };
    // Admin-only: include admin panel path (read from DB config)
    if (claims.role === 'admin') {
      try {
        const dbConfig = require('../db').config;
        const ap = dbConfig.get('admin_path');
        if (ap) payload.adminPath = '/' + ap;
      } catch (_) {}
    }
    return res.json(payload);
  }
  res.json({ authenticated: false, loginRequired: true });
});

// --- Logout ---
router.post('/auth/logout', function(req, res) {
  const sid = sessionStore.parseId(req.headers.cookie);
  sessionStore.destroy(sid);
  sessionStore.clearCookie(res);
  res.json({ ok: true });
});

// =============================================================================
// MIDDLEWARE — exported for the consuming application
// =============================================================================
// Every middleware resolves identity via JWT verification.
// The server never sees raw credentials — only cryptographically verified claims.

// Sets req.user if JWT-verified session exists, never rejects.
// Used for read endpoints — server decides what data to include based on role.
function optionalAuth(req, _res, next) {
  const claims = resolveIdentity(req);
  if (claims) {
    req.user = { id: claims.sub, name: claims.name, role: claims.role, email: claims.email, groups: claims.groups };
  }
  next();
}

// Rejects with 401 if no valid JWT-verified session
function requireAuth(req, res, next) {
  const claims = resolveIdentity(req);
  if (!claims) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  req.user = { id: claims.sub, name: claims.name, role: claims.role, email: claims.email, groups: claims.groups };
  next();
}

// Rejects with 403 if not admin (after JWT verification)
function requireAdmin(req, res, next) {
  const claims = resolveIdentity(req);
  if (!claims) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (claims.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'FORBIDDEN' });
  }
  req.user = { id: claims.sub, name: claims.name, role: claims.role, email: claims.email, groups: claims.groups };
  next();
}

// Verify session from request (programmatic use by consuming application)
function verifySession(req) {
  const claims = resolveIdentity(req);
  if (!claims) return null;
  return { user: { id: claims.sub, name: claims.name, role: claims.role, email: claims.email, groups: claims.groups } };
}

module.exports = {
  routes: router,
  optionalAuth: optionalAuth,
  requireAuth: requireAuth,
  requireAdmin: requireAdmin,
  verifySession: verifySession,
};
