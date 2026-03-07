var crypto = require('crypto');

// Security headers — applied to every response
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
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

  // Allow requests with no Origin (same-origin, non-browser clients like curl)
  var origin = req.headers.origin;
  if (!origin) return next();

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

module.exports = { securityHeaders, requestId, originCheck, errorHandler };
