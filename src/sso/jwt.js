// Minimal JWT implementation — HS256 (HMAC-SHA256).
// Zero external dependencies. Production-grade token format.
// Replace with `jsonwebtoken` or OIDC library for real deployments.

const crypto = require('crypto');

const SECRET = process.env.SSO_JWT_SECRET || crypto.randomBytes(32).toString('hex');

function base64url(buf) {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function sign(payload, expiresInSec) {
  const now = Math.floor(Date.now() / 1000);
  const claims = Object.assign({}, payload, {
    iat: now,
    exp: now + (expiresInSec || 3600),
    iss: 'claude-kanban-sso',
    jti: crypto.randomUUID(),
  });

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claims));
  const signature = base64url(
    crypto.createHmac('sha256', SECRET).update(header + '.' + body).digest()
  );

  return header + '.' + body + '.' + signature;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  // Verify signature (constant-time)
  const expected = crypto.createHmac('sha256', SECRET)
    .update(parts[0] + '.' + parts[1])
    .digest();
  const actual = base64urlDecode(parts[2]);
  if (actual.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(actual, expected)) return null;

  // Decode and check expiry
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(parts[1]).toString('utf-8'));
  } catch (_) { return null; }

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.iss !== 'claude-kanban-sso') return null;

  return payload;
}

module.exports = { sign: sign, verify: verify };
