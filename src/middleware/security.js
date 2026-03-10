const crypto = require('crypto');
const { log } = require('../lib/logger');

// Security headers — applied to every response
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // M1 fix: Content-Security-Policy (nonce for admin inline scripts)
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'nonce-" + nonce + "'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  // M2 fix: HSTS when behind HTTPS proxy
  if (req.headers['x-forwarded-proto'] === 'https' || process.env.ENABLE_HSTS === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // L3 fix: Cache-Control — no-store for dynamic, cacheable for static assets
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    res.setHeader('Cache-Control', 'no-store');
  } else if (req.path.match(/\.(js|css|png|jpg|svg|ico|woff2?|ttf|eot)(\?|$)/)) {
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  } else {
    // HTML pages: short cache, revalidate on each visit
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
  }
  next();
}

// Request ID — correlation ID for every request
function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// Origin validation — blocks cross-origin state-changing requests
// Defense-in-depth on top of SameSite=Strict cookies.
// Even if SameSite is bypassed (browser bugs, proxy stripping), this catches it.
function originCheck(req, res, next) {
  // Only check state-changing methods
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  // M4 fix: require X-Requested-With when Origin is absent (CSRF protection for non-browser tools)
  const origin = req.headers.origin;
  if (!origin) {
    if (req.headers['x-requested-with'] === 'XMLHttpRequest') return next();
    return res.status(403).json({
      error: 'Missing Origin or X-Requested-With header',
      code: 'CSRF_PROTECTION',
      requestId: req.id,
    });
  }

  // Parse allowed origins from the request's own host
  const host = req.headers.host;
  const allowed = [
    'http://' + host,
    'https://' + host,
    'http://localhost:' + (req.socket.localPort || ''),
    'http://127.0.0.1:' + (req.socket.localPort || ''),
  ];

  if (allowed.includes(origin)) return next();

  // Cross-origin state-changing request — reject
  log.error({ origin, allowed }, 'Origin rejected');
  res.status(403).json({
    error: 'Cross-origin request blocked',
    code: 'ORIGIN_REJECTED',
    requestId: req.id,
  });
}

// Centralized error handler — last middleware in the chain
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = status === 500 ? 'Internal server error' : err.message;
  log.error({ reqId: req.id, method: req.method, path: req.path, err: err.message }, 'Request error');
  res.status(status).json({
    error: message,
    code: err.code || 'INTERNAL_ERROR',
    requestId: req.id,
  });
}

// L8 fix: reject non-JSON Content-Type on API POST/PUT endpoints
function requireJsonContentType(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PUT') return next();
  if (!req.path.startsWith('/api')) return next();
  // Skip auth endpoints that may not send JSON (logout, etc.)
  if (req.path.startsWith('/api/auth/')) return next();
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json') && req.headers['content-length'] !== '0') {
    return res.status(415).json({ error: 'Content-Type must be application/json', code: 'UNSUPPORTED_MEDIA', requestId: req.id });
  }
  next();
}

// Auto-enrich error responses with requestId — ensures uniform { error, code, requestId } schema
function enrichErrorResponse(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if (body && body.error && req.id) {
      if (!body.requestId) body.requestId = req.id;
      if (!body.code) body.code = 'UNKNOWN_ERROR';
    }
    return originalJson(body);
  };
  next();
}

module.exports = { securityHeaders, requestId, enrichErrorResponse, originCheck, errorHandler, requireJsonContentType };
