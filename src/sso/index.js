// =============================================================================
// SSO Identity Provider — Isolated, Self-Contained, Enterprise-Pattern
// =============================================================================
//
// This module is the SOLE identity authority. It owns:
//   - First-run setup wizard (GET/POST /auth/setup)
//   - Login page UI (GET /auth/login)
//   - Authentication endpoint (POST /auth/login)
//   - Logout endpoint (POST /auth/logout)
//   - Session check (GET /auth/session)
//   - User management API (GET/POST/PUT/DELETE /api/users)
//   - SSO config API (GET /api/sso-config)
//   - JWT token issuance (OIDC-standard claims: sub, name, role, email, groups)
//   - JWT cryptographic verification (HS256)
//   - User store + credential validation
//
// Role hierarchy:
//   superadmin > admin > user
//   - superadmin: user management, SSO config, control panel, all features
//   - admin: control panel, pipeline management (no user management)
//   - user: board access only (future: layered permissions)
//
// To replace with real OIDC/SAML:
//   1. Delete this folder (src/sso/)
//   2. Create a new module exporting the same interface:
//      - routes: Express router handling /auth/*
//      - optionalAuth(req, res, next): sets req.user if valid, never rejects
//      - requireAuth(req, res, next): rejects 401 if not authenticated
//      - requireAdmin(req, res, next): rejects 403 if not admin
//      - requireSuperAdmin(req, res, next): rejects 403 if not superadmin
//      - verifySession(req): returns { user } or null
//      - init(db): initializes the user store
//   3. Mount routes, use middleware — zero changes to kanban code.
// =============================================================================

const path = require('path');
const fs = require('fs');
const express = require('express');
const { runtime } = require('../config');
const users = require('./users');
const userStore = require('./user-store');
const jwt = require('./jwt');
const sessionStore = require('./session-store');
const { rateLimiter } = require('../middleware/rate-limit');

const router = express.Router();
router.use(rateLimiter);

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

// --- Safe return URL validation ---
const { BASE_PATH } = require('../config');

function safeReturnUrl(raw) {
  const fallback = BASE_PATH + '/';
  if (!raw || typeof raw !== 'string') return fallback;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return fallback;
  return raw;
}

// --- First-Run Setup Page ---
// Only available when setup is not complete. Permanently locked after first setup.
router.get('/auth/setup', function(req, res) {
  if (userStore.isSetupComplete()) {
    return res.redirect(BASE_PATH + '/');
  }
  let html = fs.readFileSync(path.join(__dirname, 'views', 'setup.html'), 'utf-8');
  const nonce = res.locals.cspNonce || '';
  if (nonce) html = html.replace('<script>', '<script nonce="' + nonce + '">');
  const bpScript = '<script nonce="' + nonce + '">window.__BASE_PATH__=' + JSON.stringify(BASE_PATH) + ';</script>';
  html = html.replace('</head>', bpScript + '</head>');
  res.type('html').send(html);
});

// --- First-Run Setup Submit ---
router.post('/auth/setup', async function(req, res) {
  if (userStore.isSetupComplete()) {
    return res.status(403).json({ ok: false, error: 'Setup already complete. Reclone or reinstall to access setup again.' });
  }

  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.displayName || '').trim();
  const email = String(body.email || '').trim();
  const ssoConfig = body.ssoConfig || { provider: 'builtin' };

  // --- Input validation (all checks before any permanent state changes) ---
  if (!username || username.length < 2) {
    return res.status(400).json({ ok: false, error: 'Username must be at least 2 characters' });
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.status(400).json({ ok: false, error: 'Username: only letters, numbers, underscore, dot, hyphen' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  }

  // --- Path validation BEFORE any permanent changes ---
  const { config: dbConfig } = require('../db');
  const { runtime, ROOT_DIR } = require('../config');
  const kanbanMode = String(body.kanbanMode || 'global').trim();
  const pathFs = require('fs');
  const pathDir = require('path');

  var effectivePath = null;
  if (kanbanMode === 'single-project') {
    const singlePath = String(body.singleProjectPath || '').trim();
    effectivePath = singlePath || pathDir.resolve(ROOT_DIR, '..');
    try {
      pathFs.mkdirSync(effectivePath, { recursive: true });
      const probe = pathDir.join(effectivePath, '.write-probe-' + Date.now());
      pathFs.writeFileSync(probe, '');
      pathFs.unlinkSync(probe);
    } catch (e) {
      const { log: setupLog } = require('../lib/logger');
      setupLog.warn({ path: effectivePath, err: e.message }, 'Setup: project path not writable');
      return res.status(400).json({
        ok: false,
        error: 'Cannot write to project path: ' + effectivePath + '. '
          + 'The server process does not have permission. '
          + 'Either choose a path the service user can write to, '
          + 'or SSH in and run: sudo mkdir -p "' + effectivePath + '" && sudo chown $(whoami) "' + effectivePath + '"'
      });
    }
  } else {
    const projectsRoot = String(body.projectsRoot || '').trim();
    if (projectsRoot) {
      try {
        pathFs.mkdirSync(projectsRoot, { recursive: true });
        const probe = pathDir.join(projectsRoot, '.write-probe-' + Date.now());
        pathFs.writeFileSync(probe, '');
        pathFs.unlinkSync(probe);
      } catch (e) {
        const { log: setupLog } = require('../lib/logger');
        setupLog.warn({ path: projectsRoot, err: e.message }, 'Setup: projects root not writable');
        return res.status(400).json({
          ok: false,
          error: 'Cannot write to projects root: ' + projectsRoot + '. '
            + 'The server process does not have permission. '
            + 'Either choose a writable path, '
            + 'or SSH in and run: sudo mkdir -p "' + projectsRoot + '" && sudo chown $(whoami) "' + projectsRoot + '"'
        });
      }
    }
  }

  // --- All validation passed. Now commit permanent state. ---

  const result = await userStore.createUser(
    username, password, 'superadmin', displayName || username, email,
    ['superadministrators', 'administrators', 'users'], 'setup-wizard'
  );
  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  userStore.completeSetup(ssoConfig);

  // --- Operating Mode Configuration ---
  if (kanbanMode === 'single-project') {
    runtime.mode = 'single-project';
    runtime.autoPromoteBrainstorm = true;
    runtime.singleProjectPath = effectivePath;
    dbConfig.set('kanban_mode', 'single-project');
    dbConfig.set('single_project_path', effectivePath);
    dbConfig.set('auto_promote_brainstorm', 'true');

    // Copy demo idea.md (path already validated writable)
    if (body.useDemoIdea) {
      try {
        const demoSrc = pathDir.join(ROOT_DIR, 'demo', 'idea.md');
        if (pathFs.existsSync(demoSrc)) {
          const destPath = pathDir.join(effectivePath, 'idea.md');
          if (!pathFs.existsSync(destPath)) {
            pathFs.copyFileSync(demoSrc, destPath);
          }
        }
      } catch (e) {
        const { log: setupLog } = require('../lib/logger');
        setupLog.warn({ path: effectivePath, err: e.message }, 'Could not copy demo idea.md');
      }
    }
  } else {
    const projectsRoot = String(body.projectsRoot || '').trim();
    runtime.mode = 'global';
    dbConfig.set('kanban_mode', 'global');
    if (projectsRoot) {
      dbConfig.set('projects_root', projectsRoot);
    }
  }

  const { log } = require('../lib/logger');
  log.info({ username, provider: ssoConfig.provider, mode: kanbanMode }, 'First-run setup completed');

  res.json({ ok: true });
});

// --- Claude CLI auth status (works during setup phase only) ---
router.get('/auth/claude-status', function(req, res) {
  const { execFileSync } = require('child_process');
  var cliInstalled = false;
  try { execFileSync('claude', ['--version'], { timeout: 5000, stdio: 'pipe' }); cliInstalled = true; } catch (_) {}
  var authenticated = false;
  if (cliInstalled) {
    const os = require('os');
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    authenticated = fs.existsSync(credPath);
  }
  res.json({ cliInstalled: cliInstalled, authenticated: authenticated });
});

// --- Claude CLI auth start (spawns device code flow, returns URL) ---
var _claudeAuthProc = null;
router.post('/auth/claude-auth', function(req, res) {
  if (_claudeAuthProc) {
    return res.status(409).json({ error: 'Auth already in progress' });
  }
  const { spawn: spawnProc } = require('child_process');
  var output = '';
  var responded = false;

  _claudeAuthProc = spawnProc('claude', ['auth', 'login'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000,
  });

  function tryRespond() {
    if (responded) return;
    // Look for URL pattern in output
    var urlMatch = output.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      responded = true;
      res.json({ ok: true, output: output.trim(), url: urlMatch[1] });
    }
  }

  _claudeAuthProc.stdout.on('data', function(chunk) {
    output += chunk.toString();
    tryRespond();
  });
  _claudeAuthProc.stderr.on('data', function(chunk) {
    output += chunk.toString();
    tryRespond();
  });

  _claudeAuthProc.on('close', function() {
    _claudeAuthProc = null;
    if (!responded) {
      responded = true;
      res.json({ ok: false, output: output.trim() || 'Claude auth process exited without URL' });
    }
  });
  _claudeAuthProc.on('error', function(err) {
    _claudeAuthProc = null;
    if (!responded) {
      responded = true;
      res.status(500).json({ error: 'Failed to start claude auth: ' + err.message });
    }
  });

  // Timeout: if no URL found in 15s, return whatever we have
  setTimeout(function() {
    if (!responded) {
      responded = true;
      res.json({ ok: false, output: output.trim() || 'Timed out waiting for device code' });
    }
  }, 15000);
});

// --- Login page (served by SSO, not by the application) ---
router.get('/auth/login', function(req, res) {
  const claims = resolveIdentity(req);
  if (claims) {
    return res.redirect(safeReturnUrl(req.query.return));
  }
  let html = fs.readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf-8');
  const nonce = res.locals.cspNonce || '';
  if (nonce) html = html.replace('<script>', '<script nonce="' + nonce + '">');
  const bpScript = '<script nonce="' + nonce + '">window.__BASE_PATH__=' + JSON.stringify(BASE_PATH) + ';</script>';
  html = html.replace('</head>', bpScript + '</head>');
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
    }, runtime.jwtTtlMins * 60);

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
    // Admin or superadmin: include admin panel path
    if (claims.role === 'admin' || claims.role === 'superadmin') {
      try {
        const dbConfig = require('../db').config;
        const ap = dbConfig.get('admin_path');
        if (ap) payload.adminPath = BASE_PATH + '/' + ap;
      } catch (_) {}
    }
    // Superadmin: include user management flag
    if (claims.role === 'superadmin') {
      payload.userManagement = true;
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
// USER MANAGEMENT API — superadmin only
// =============================================================================

// List all users
router.get('/api/users', function(req, res) {
  const claims = resolveIdentity(req);
  if (!claims) return res.status(401).json({ error: 'Authentication required' });
  if (claims.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });

  res.json({ users: userStore.listUsers() });
});

// Create user
router.post('/api/users', async function(req, res) {
  const claims = resolveIdentity(req);
  if (!claims) return res.status(401).json({ error: 'Authentication required' });
  if (claims.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });

  const body = req.body || {};
  const result = await userStore.createUser(
    String(body.username || '').trim(),
    String(body.password || ''),
    String(body.role || 'user'),
    String(body.displayName || '').trim(),
    String(body.email || '').trim(),
    body.groups || null,
    claims.sub
  );

  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Update user
router.put('/api/users/:id', async function(req, res) {
  const claims = resolveIdentity(req);
  if (!claims) return res.status(401).json({ error: 'Authentication required' });
  if (claims.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });

  const result = await userStore.updateUser(req.params.id, req.body || {}, claims.role);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Delete user
router.delete('/api/users/:id', function(req, res) {
  const claims = resolveIdentity(req);
  if (!claims) return res.status(401).json({ error: 'Authentication required' });
  if (claims.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });

  const result = userStore.deleteUser(req.params.id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Get SSO configuration (redacted secrets)
router.get('/api/sso-config', function(req, res) {
  const claims = resolveIdentity(req);
  if (!claims) return res.status(401).json({ error: 'Authentication required' });
  if (claims.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });

  res.json(userStore.getSsoConfig());
});

// =============================================================================
// MIDDLEWARE — exported for the consuming application
// =============================================================================
// Every middleware resolves identity via JWT verification.
// The server never sees raw credentials — only cryptographically verified claims.

function buildUserObj(claims) {
  return { id: claims.sub, name: claims.name, role: claims.role, email: claims.email, groups: claims.groups };
}

// Sets req.user if JWT-verified session exists, never rejects.
function optionalAuth(req, _res, next) {
  const claims = resolveIdentity(req);
  if (claims) req.user = buildUserObj(claims);
  next();
}

// Rejects with 401 if no valid JWT-verified session
function requireAuth(req, res, next) {
  const claims = resolveIdentity(req);
  if (!claims) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  req.user = buildUserObj(claims);
  next();
}

// Rejects with 403 if not admin or superadmin (after JWT verification)
function requireAdmin(req, res, next) {
  const claims = resolveIdentity(req);
  if (!claims) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (claims.role !== 'admin' && claims.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin access required', code: 'FORBIDDEN' });
  }
  req.user = buildUserObj(claims);
  next();
}

// Rejects with 403 if not superadmin (after JWT verification)
function requireSuperAdmin(req, res, next) {
  const claims = resolveIdentity(req);
  if (!claims) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (claims.role !== 'superadmin') {
    return res.status(403).json({ error: 'Super Admin access required', code: 'FORBIDDEN' });
  }
  req.user = buildUserObj(claims);
  next();
}

// Verify session from request (programmatic use by consuming application)
function verifySession(req) {
  const claims = resolveIdentity(req);
  if (!claims) return null;
  return { user: buildUserObj(claims) };
}

// Initialize user store with DB reference
function init(db) {
  return userStore.init(db);
}

module.exports = {
  routes: router,
  optionalAuth: optionalAuth,
  requireAuth: requireAuth,
  requireAdmin: requireAdmin,
  requireSuperAdmin: requireSuperAdmin,
  verifySession: verifySession,
  init: init,
  isSetupComplete: function() { return userStore.isSetupComplete(); },
};
