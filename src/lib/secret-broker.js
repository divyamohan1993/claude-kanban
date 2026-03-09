// =============================================================================
// Secret Broker Client — Encrypted comms + HKDF key splitting
// =============================================================================
//
// Fetches secrets from CF Worker vault at startup. All communication is
// AES-256-GCM encrypted on top of TLS. Master key is derived via HKDF from
// two halves: one from the vault, one from .env. Neither half alone is useful.
//
// Config (.env):
//   SECRET_BROKER_URL=https://vault.your-random-subdomain.workers.dev/secrets
//   SECRET_BROKER_HMAC_KEY=<key A — for request signing>
//   SECRET_BROKER_ENC_KEY=<key B — for AES-256-GCM, hex, 32 bytes>
//   SECRET_BROKER_DERIVE_KEY=<half B — for HKDF key derivation>
//
// If SECRET_BROKER_URL is not set, broker is disabled (local dev fallback).

const crypto = require('crypto');
const { log } = require('./logger');

const BROKER_URL = process.env.SECRET_BROKER_URL || '';
const HMAC_KEY = process.env.SECRET_BROKER_HMAC_KEY || '';
const ENC_KEY = process.env.SECRET_BROKER_ENC_KEY || '';
const DERIVE_KEY = process.env.SECRET_BROKER_DERIVE_KEY || '';

// In-memory secret store (never written to disk)
const secrets = new Map();
let initialized = false;
let brokerEnabled = false;

// =============================================================================
// AES-256-GCM — Encrypt/Decrypt (matches Worker format: iv:tag:ciphertext hex)
// =============================================================================

function aesEncrypt(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

function aesDecrypt(encoded, keyHex) {
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// =============================================================================
// HKDF — Derive final key from two halves (Layer 10: Key Splitting)
// =============================================================================

function deriveKey(workerHalf, clientHalf, info) {
  // HKDF-SHA256: ikm = workerHalf, salt = clientHalf, info = context string
  // Neither half alone can produce the derived key
  const ikm = Buffer.from(workerHalf, 'hex');
  const salt = Buffer.from(clientHalf, 'hex');
  return crypto.hkdfSync('sha256', ikm, salt, info, 32);
}

// =============================================================================
// INIT — fetch all secrets from vault
// =============================================================================

async function init() {
  if (!BROKER_URL || !HMAC_KEY || !ENC_KEY) {
    log.info('Secret broker disabled (missing SECRET_BROKER_URL/HMAC_KEY/ENC_KEY). Using local fallback.');
    brokerEnabled = false;
    initialized = true;
    return;
  }

  brokerEnabled = true;
  log.info({ url: BROKER_URL.replace(/^(https?:\/\/[^/]+).*/, '$1/***') }, 'Connecting to secret vault...');

  // Encrypt the request body with key B (Layer 8)
  const requestJson = JSON.stringify({ keys: ['*'] });
  const encryptedBody = aesEncrypt(requestJson, ENC_KEY);

  // Sign with key A (Layer 6 + 7)
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = timestamp + '.' + nonce + '.' + encryptedBody;
  const signature = crypto.createHmac('sha256', HMAC_KEY).update(message).digest('hex');

  let res;
  try {
    res = await fetch(BROKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': signature,
      },
      body: encryptedBody,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new Error('Secret vault unreachable: ' + err.message);
  }

  if (!res.ok) {
    const text = await res.text().catch(function() { return ''; });
    throw new Error('Secret vault returned ' + res.status + ': ' + text);
  }

  // Decrypt response (Layer 9)
  const encryptedResponse = await res.text();
  let responseJson;
  try {
    responseJson = aesDecrypt(encryptedResponse, ENC_KEY);
  } catch (err) {
    throw new Error('Failed to decrypt vault response: ' + err.message);
  }

  let data;
  try {
    data = JSON.parse(responseJson);
  } catch (_) {
    throw new Error('Vault returned invalid JSON after decryption');
  }

  if (!data.secrets || typeof data.secrets !== 'object') {
    throw new Error('Vault returned invalid payload');
  }

  const keys = Object.keys(data.secrets);
  for (const k of keys) {
    secrets.set(k, data.secrets[k]);
  }

  initialized = true;
  // Log key names (truncated) but never values
  log.info({ served: keys.length, keys: keys.map(function(k) { return k.slice(0, 4) + '***'; }) }, 'Secrets loaded into memory');
}

// =============================================================================
// GET — read a raw secret from memory
// =============================================================================

function get(key) {
  if (!initialized) throw new Error('Secret broker not initialized. Call broker.init() first.');
  return secrets.get(key) || null;
}

// =============================================================================
// DERIVE MASTER KEY — HKDF from worker half + client half (Layer 10)
// =============================================================================

function deriveMasterKey() {
  if (!initialized) throw new Error('Secret broker not initialized.');

  const workerHalf = secrets.get('MASTER_KEY_SHARE');
  if (!workerHalf) return null;

  if (!DERIVE_KEY) {
    log.error('MASTER_KEY_SHARE found in vault but SECRET_BROKER_DERIVE_KEY missing from .env');
    return null;
  }

  // HKDF: neither half alone produces the key
  const derived = deriveKey(workerHalf, DERIVE_KEY, 'claude-kanban-master-key-v1');
  return Buffer.from(derived);
}

// =============================================================================
// STATUS
// =============================================================================

function isEnabled() { return brokerEnabled; }
function isReady() { return initialized; }
function keyCount() { return secrets.size; }

module.exports = { init, get, deriveMasterKey, isEnabled, isReady, keyCount };
