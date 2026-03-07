var crypto = require('crypto');

// Security headers — applied to every response
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // M1 fix: Content-Security-Policy
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  // M2 fix: HSTS when behind HTTPS proxy
  if (req.headers['x-forwarded-proto'] === 'https' || process.env.ENABLE_HSTS === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // L3 fix: Cache-Control — no-store for API, cacheable for static
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
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
  var origin = req.headers.origin;
  if (!origin) {
    if (req.headers['x-requested-with'] === 'XMLHttpRequest') return next();
    return res.status(403).json({
      error: 'Missing Origin or X-Requested-With header',
      code: 'CSRF_PROTECTION',
      requestId: req.id,
    });
  }

  // Parse allowed origins from the request's own host
  var host = req.headers.host;
  var allowed = [
    'http://' + host,
    'https://' + host,
    'http://localhost:' + (req.socket.localPort || ''),
    'http://127.0.0.1:' + (req.socket.localPort || ''),
  ];

  if (allowed.includes(origin)) return next();

  // Cross-origin state-changing request — reject
  console.error('[security] Origin rejected:', origin, 'not in', allowed.join(', '));
  res.status(403).json({
    error: 'Cross-origin request blocked',
    code: 'ORIGIN_REJECTED',
    requestId: req.id,
  });
}

// Centralized error handler — last middleware in the chain
function errorHandler(err, req, res, _next) {
  var status = err.status || err.statusCode || 500;
  var message = status === 500 ? 'Internal server error' : err.message;
  console.error('[error]', req.id || '-', req.method, req.path, err.message);
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
  var ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json') && req.headers['content-length'] !== '0') {
    return res.status(415).json({ error: 'Content-Type must be application/json', code: 'UNSUPPORTED_MEDIA', requestId: req.id });
  }
  next();
}

module.exports = { securityHeaders, requestId, originCheck, errorHandler, requireJsonContentType };
