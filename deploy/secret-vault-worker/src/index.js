// =============================================================================
// Cloudflare Worker — Secret Vault (10-Layer Defense in Depth)
// =============================================================================
//
// Secrets stored as Worker env vars (encrypted at rest by CF).
// Every layer is independent; compromising one gives you nothing.
//
// LAYERS:
//   1. CF edge DDoS/bot protection (automatic, free tier)
//   2. Geo-fence: reject requests from non-allowed countries
//   3. IP allowlist: CF-Connecting-IP (unforgeable at TCP level)
//   4. Progressive lockout: 3 failures from any IP = permanent block
//   5. Rate limit: 5 requests per minute per IP
//   6. HMAC-SHA256 authentication (key A)
//   7. Timestamp (30s window) + nonce (anti-replay)
//   8. Encrypted request body (AES-256-GCM with key B)
//   9. Encrypted response body (AES-256-GCM with key B)
//  10. Key splitting: Worker has half, client has half, HKDF derives real key
//
// Protocol:
//   POST /secrets
//   Headers:
//     X-Timestamp: <unix-seconds>
//     X-Nonce: <random-hex-32>
//     X-Signature: HMAC-SHA256(keyA, timestamp + "." + nonce + "." + encryptedBody)
//   Body: AES-256-GCM encrypted JSON with key B
//     Plaintext: { "keys": ["MASTER_KEY_SHARE", "JWT_SECRET"] }
//     Format: <iv-hex>:<tag-hex>:<ciphertext-hex>
//
// Response (200):
//   Body: AES-256-GCM encrypted JSON with key B
//     Plaintext: { "secrets": { ... }, "ts": 1234, "served": N }
//
// Client derives final master key:
//   HKDF-SHA256(ikm = MASTER_KEY_SHARE from worker, salt = DERIVE_KEY from .env,
//               info = "claude-kanban-master-key-v1")
//
// Setup (wrangler):
//   npx wrangler secret put HMAC_KEY               # key A (shared with client)
//   npx wrangler secret put ENC_KEY                 # key B (shared with client, hex, 32 bytes)
//   npx wrangler secret put ALLOWED_IPS             # comma-separated: "1.2.3.4,5.6.7.8"
//   npx wrangler secret put ALLOWED_COUNTRIES       # comma-separated: "IN,US" (ISO 3166-1 alpha-2)
//   npx wrangler secret put VAULT_MASTER_KEY_SHARE  # half of the master key (hex, 32 bytes)
//   npx wrangler secret put VAULT_JWT_SECRET        # JWT signing secret
//   npx wrangler secret put VAULT_<ANY_NAME>        # any additional secrets

// =============================================================================
// Constants
// =============================================================================

const REPLAY_WINDOW_SEC = 30;
const NONCE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;
const LOCKOUT_MAX_FAILURES = 3;

// In-memory stores (per isolate; reset on deploy)
const usedNonces = new Map();
const rateLimits = new Map();
const failureCounts = new Map();  // IP -> count (permanent lockout after N failures)
const lockedIps = new Set();

// =============================================================================
// Main handler
// =============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only POST /secrets — everything else is a 404 (no information leakage)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (url.pathname !== '/secrets' || request.method !== 'POST') {
      return errorResponse(404, 'NOT_FOUND');
    }

    const clientIp = request.headers.get('CF-Connecting-IP') || '';
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    // =========================================================================
    // LAYER 2: Geo-fence
    // =========================================================================
    const allowedCountries = (env.ALLOWED_COUNTRIES || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    if (allowedCountries.length > 0) {
      const reqCountry = (request.cf && request.cf.country) || '';
      if (!allowedCountries.includes(reqCountry.toUpperCase())) {
        return errorResponse(403, 'GEO_BLOCKED');
      }
    }

    // =========================================================================
    // LAYER 3: IP allowlist
    // =========================================================================
    const allowedIps = (env.ALLOWED_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);
    if (allowedIps.length > 0 && !allowedIps.includes(clientIp)) {
      return errorResponse(403, 'IP_BLOCKED');
    }

    // =========================================================================
    // LAYER 4: Progressive lockout (permanent after N failures)
    // =========================================================================
    if (lockedIps.has(clientIp)) {
      return errorResponse(403, 'LOCKED_OUT');
    }

    // =========================================================================
    // LAYER 5: Rate limiting
    // =========================================================================
    pruneRateLimits(now);
    const hits = rateLimits.get(clientIp) || [];
    const recentHits = hits.filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    if (recentHits.length >= RATE_LIMIT_MAX) {
      recordFailure(clientIp);
      return errorResponse(429, 'RATE_LIMITED');
    }
    recentHits.push(now);
    rateLimits.set(clientIp, recentHits);

    // =========================================================================
    // LAYER 6 + 7: HMAC-SHA256 + Timestamp + Nonce
    // =========================================================================
    const timestamp = request.headers.get('X-Timestamp');
    const nonce = request.headers.get('X-Nonce');
    const signature = request.headers.get('X-Signature');

    if (!timestamp || !nonce || !signature) {
      recordFailure(clientIp);
      return errorResponse(401, 'AUTH_MISSING');
    }

    // Layer 7a: Timestamp freshness
    const tsNum = parseInt(timestamp, 10);
    if (isNaN(tsNum) || Math.abs(nowSec - tsNum) > REPLAY_WINDOW_SEC) {
      recordFailure(clientIp);
      return errorResponse(401, 'TIMESTAMP_EXPIRED');
    }

    // Layer 7b: Nonce uniqueness
    pruneNonces(now);
    if (usedNonces.has(nonce)) {
      recordFailure(clientIp);
      return errorResponse(401, 'NONCE_REUSED');
    }

    // Read raw body (encrypted with key B)
    let rawBody;
    try {
      rawBody = await request.text();
    } catch (_) {
      recordFailure(clientIp);
      return errorResponse(400, 'BODY_UNREADABLE');
    }

    // Layer 6: HMAC verification — sign(timestamp + "." + nonce + "." + encryptedBody)
    if (!env.HMAC_KEY) {
      return errorResponse(500, 'CONFIG_MISSING');
    }

    const hmacMessage = timestamp + '.' + nonce + '.' + rawBody;
    const hmacKey = await crypto.subtle.importKey(
      'raw', encode(env.HMAC_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const expectedSig = bufToHex(await crypto.subtle.sign('HMAC', hmacKey, encode(hmacMessage)));

    if (!timingSafeEqual(signature, expectedSig)) {
      recordFailure(clientIp);
      return errorResponse(401, 'SIG_INVALID');
    }

    // HMAC passed — record nonce to prevent replay
    usedNonces.set(nonce, now);

    // =========================================================================
    // LAYER 8: Decrypt request body (AES-256-GCM with key B)
    // =========================================================================
    if (!env.ENC_KEY) {
      return errorResponse(500, 'CONFIG_MISSING');
    }

    let requestJson;
    try {
      requestJson = await aesDecrypt(rawBody, env.ENC_KEY);
    } catch (_) {
      recordFailure(clientIp);
      return errorResponse(400, 'DECRYPT_FAILED');
    }

    let parsed;
    try {
      parsed = JSON.parse(requestJson);
    } catch (_) {
      recordFailure(clientIp);
      return errorResponse(400, 'JSON_INVALID');
    }

    const requestedKeys = parsed.keys;
    if (!Array.isArray(requestedKeys) || requestedKeys.length === 0) {
      return errorResponse(400, 'KEYS_MISSING');
    }

    // =========================================================================
    // Collect secrets (VAULT_ prefixed env vars)
    // =========================================================================
    const secrets = {};
    const allVaultKeys = Object.keys(env).filter(k => k.startsWith('VAULT_'));
    const wantAll = requestedKeys.length === 1 && requestedKeys[0] === '*';

    if (wantAll) {
      for (const k of allVaultKeys) {
        secrets[k.slice(6)] = env[k];
      }
    } else {
      for (const reqKey of requestedKeys) {
        const envKey = 'VAULT_' + reqKey;
        if (env[envKey] !== undefined) {
          secrets[reqKey] = env[envKey];
        }
      }
    }

    // =========================================================================
    // LAYER 9: Encrypt response body (AES-256-GCM with key B)
    // =========================================================================
    const responseJson = JSON.stringify({
      secrets: secrets,
      ts: nowSec,
      served: Object.keys(secrets).length,
    });

    let encryptedResponse;
    try {
      encryptedResponse = await aesEncrypt(responseJson, env.ENC_KEY);
    } catch (_) {
      return errorResponse(500, 'ENCRYPT_FAILED');
    }

    // Success — clear failure count for this IP
    failureCounts.delete(clientIp);

    return new Response(encryptedResponse, {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'text/plain' }, corsHeaders()),
    });
  },
};

// =============================================================================
// AES-256-GCM encryption/decryption
// Format: <iv-hex-24>:<tag-hex-32>:<ciphertext-hex>
// =============================================================================

async function aesEncrypt(plaintext, keyHex) {
  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv, tagLength: 128 },
    key,
    encode(plaintext)
  );
  // WebCrypto appends the 16-byte auth tag to the ciphertext
  const combined = new Uint8Array(encrypted);
  const ciphertext = combined.slice(0, combined.length - 16);
  const tag = combined.slice(combined.length - 16);
  return bufToHex(iv) + ':' + bufToHex(tag) + ':' + bufToHex(ciphertext);
}

async function aesDecrypt(encoded, keyHex) {
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid format');
  const iv = hexToBytes(parts[0]);
  const tag = hexToBytes(parts[1]);
  const ciphertext = hexToBytes(parts[2]);
  // WebCrypto expects tag appended to ciphertext
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv, tagLength: 128 },
    key,
    combined
  );
  return new TextDecoder().decode(decrypted);
}

// =============================================================================
// Helpers
// =============================================================================

function errorResponse(status, code) {
  // Minimal error body — no stack traces, no internal details
  return new Response(JSON.stringify({ error: code }), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()),
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Timestamp, X-Nonce, X-Signature',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function encode(str) {
  return new TextEncoder().encode(str);
}

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

// Constant-time string comparison
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function recordFailure(ip) {
  const count = (failureCounts.get(ip) || 0) + 1;
  failureCounts.set(ip, count);
  if (count >= LOCKOUT_MAX_FAILURES) {
    lockedIps.add(ip);
  }
}

function pruneNonces(now) {
  for (const [n, t] of usedNonces) {
    if (now - t > NONCE_TTL_MS) usedNonces.delete(n);
  }
}

function pruneRateLimits(now) {
  for (const [ip, hits] of rateLimits) {
    const recent = hits.filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) rateLimits.delete(ip);
    else rateLimits.set(ip, recent);
  }
}
