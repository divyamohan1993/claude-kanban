// =============================================================================
// DB-Backed User Store — AES-256-GCM Encrypted Fields + Argon2id Passwords
// =============================================================================
//
// Replaces hardcoded user array with SQLite-backed identity store.
// Sensitive fields (email) encrypted at rest with AES-256-GCM.
// Passwords hashed with Argon2id (irreversible, quantum-resistant).
//
// Role hierarchy: superadmin > admin > user
// - superadmin: full system control, user management, SSO config
// - admin: control panel, pipeline management
// - user: board access only (future: layered permissions)

const crypto = require('crypto');
const argon2 = require('argon2');
const { log } = require('../lib/logger');
const broker = require('../lib/secret-broker');

const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 };
const VALID_ROLES = ['superadmin', 'admin', 'user'];

// Dummy hash for timing-safe rejection (computed once at init)
let DUMMY_HASH = '';

// DB reference, set via init()
let dbUsers = null;
let dbConfig = null;
let masterKey = null;

// =============================================================================
// AES-256-GCM ENCRYPTION — field-level encryption for sensitive data
// =============================================================================

function getMasterKey() {
  if (masterKey) return masterKey;

  // Priority 1: HKDF-derived key from secret vault (key splitting)
  // Worker has half A, .env has half B, HKDF(A, B) = actual key.
  // Compromising either side alone is useless.
  if (broker.isEnabled()) {
    const derived = broker.deriveMasterKey();
    if (derived) {
      masterKey = derived;
      // Migrate: purge any old master key from DB (it's now vault-derived)
      const dbKey = dbConfig.get('master_encryption_key');
      if (dbKey) {
        dbConfig.set('master_encryption_key', '');
        log.info('Purged master key from DB (now HKDF-derived from vault)');
      }
      return masterKey;
    }
    log.warn('Secret broker enabled but MASTER_KEY_SHARE not in vault. Falling back to DB.');
  }

  // Priority 2: DB config (local dev only — insecure, key co-located with data)
  let keyHex = dbConfig.get('master_encryption_key');
  if (!keyHex) {
    keyHex = crypto.randomBytes(32).toString('hex');
    dbConfig.set('master_encryption_key', keyHex);
    log.warn('[SECURITY] Master key stored in DB alongside encrypted data. Configure secret vault for production.');
  }
  masterKey = Buffer.from(keyHex, 'hex');
  return masterKey;
}

function encrypt(plaintext) {
  if (!plaintext) return '';
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(ciphertext) {
  if (!ciphertext) return '';
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return ciphertext; // plaintext fallback
  try {
    const key = getMasterKey();
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (_) {
    return ''; // corrupted data
  }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

let _ready = null;

function init(db) {
  dbUsers = db.users;
  dbConfig = db.config;

  // Verify table integrity: ensure key columns exist via a real query.
  // Catches both missing tables and corrupted schemas.
  try {
    dbUsers.count();
    dbUsers.countByRole('superadmin');
    // Probe actual column names by attempting a lookup (returns null, no side effects)
    dbUsers.getByUsername('__integrity_check__');
  } catch (err) {
    log.fatal({ err: err.message }, 'Users table corrupted or missing columns. DB may need rebuild.');
    throw err;
  }

  _ready = (async function() {
    DUMMY_HASH = await argon2.hash('dummy-timing-safe-rejection', ARGON2_OPTS);

    // Seed default users if DB is empty
    const count = dbUsers.count();
    if (count === 0) {
      await seedDefaults();
    }

    // Consistency check: if setup_complete=true but no superadmin exists,
    // reset the flag so the setup wizard can run again
    const setupDone = dbConfig.get('setup_complete') === 'true';
    const hasSA = dbUsers.countByRole('superadmin') > 0;
    if (setupDone && !hasSA) {
      dbConfig.set('setup_complete', '');
      log.warn('setup_complete was true but no superadmin exists. Reset flag; setup wizard will reappear.');
    }

    log.info({ userCount: dbUsers.count(), hasSuperAdmin: hasSA }, 'Authentication system ready');
  })();

  // Crash on init failure: if Argon2 or DB fails during init, server cannot do auth
  _ready.catch(function(err) {
    log.fatal({ err: err.message }, 'Auth init failed. Server cannot authenticate users.');
    process.exit(1);
  });

  return _ready;
}

async function seedDefaults() {
  // Demo accounts always use well-known passwords (admin/admin, user/user).
  // They are read-only: the demoGuard middleware blocks all state-changing requests.
  const adminHash = await argon2.hash('admin', ARGON2_OPTS);
  const userHash = await argon2.hash('user', ARGON2_OPTS);

  dbUsers.insert(
    'default-admin-001', 'admin', adminHash, 'admin',
    'Demo Admin', encrypt('admin@localhost'),
    JSON.stringify(['administrators', 'users']), true, 'system'
  );

  dbUsers.insert(
    'default-user-001', 'user', userHash, 'user',
    'Demo User', encrypt('user@localhost'),
    JSON.stringify(['users']), true, 'system'
  );

  log.info('Seeded demo users: admin/admin (read-only), user/user (read-only)');
}

// =============================================================================
// AUTHENTICATION
// =============================================================================

async function authenticate(username, password) {
  await _ready;

  const row = dbUsers.getByUsername(username);
  if (row && row.enabled) {
    try {
      const valid = await argon2.verify(row.password_hash, password);
      if (valid) {
        dbUsers.setLastLogin(row.id);
        return rowToUser(row);
      }
    } catch (_) {}
    return null;
  }

  // Timing-safe rejection: run dummy verify even if user not found
  try { await argon2.verify(DUMMY_HASH, password); } catch (_) {}
  return null;
}

// =============================================================================
// USER CRUD
// =============================================================================

async function createUser(username, password, role, displayName, email, groups, createdBy) {
  await _ready;

  if (!username || username.length < 2 || username.length > 64) {
    return { error: 'Username must be 2-64 characters' };
  }
  if (!password || password.length < 4) {
    return { error: 'Password must be at least 4 characters' };
  }
  if (!VALID_ROLES.includes(role)) {
    return { error: 'Invalid role. Must be: ' + VALID_ROLES.join(', ') };
  }
  // Check username uniqueness
  if (dbUsers.getByUsername(username)) {
    return { error: 'Username already exists' };
  }
  // Only one superadmin allowed
  if (role === 'superadmin' && dbUsers.countByRole('superadmin') > 0) {
    return { error: 'Only one superadmin account is allowed' };
  }

  const id = 'usr-' + crypto.randomUUID().slice(0, 12);
  const hash = await argon2.hash(password, ARGON2_OPTS);
  const emailEnc = encrypt(email || '');
  const grp = JSON.stringify(groups || (role === 'superadmin' ? ['superadministrators', 'administrators', 'users'] : role === 'admin' ? ['administrators', 'users'] : ['users']));

  dbUsers.insert(id, username, hash, role, displayName || username, emailEnc, grp, true, createdBy || 'system');

  log.info({ userId: id, username, role, createdBy }, 'User created');
  return { user: toUserInfo(rowToUser(dbUsers.getById(id))) };
}

async function updateUser(id, updates, actorRole) {
  await _ready;

  const row = dbUsers.getById(id);
  if (!row) return { error: 'User not found' };

  // Prevent role escalation: only superadmin can create/modify admins
  if (updates.role && updates.role !== row.role) {
    if (!VALID_ROLES.includes(updates.role)) return { error: 'Invalid role' };
    if (updates.role === 'superadmin') return { error: 'Cannot create superadmin via update' };
    if (actorRole !== 'superadmin') return { error: 'Only superadmin can change roles' };
  }

  // Prevent disabling the last superadmin
  if (row.role === 'superadmin' && updates.enabled === false) {
    return { error: 'Cannot disable the superadmin account' };
  }

  const displayName = updates.displayName !== undefined ? updates.displayName : row.display_name;
  const emailEnc = updates.email !== undefined ? encrypt(updates.email) : row.email_encrypted;
  const role = updates.role || row.role;
  const groups = updates.groups ? JSON.stringify(updates.groups) : row.groups;
  const enabled = updates.enabled !== undefined ? updates.enabled : row.enabled;

  dbUsers.update(id, displayName, emailEnc, role, groups, enabled);

  if (updates.password) {
    const hash = await argon2.hash(updates.password, ARGON2_OPTS);
    dbUsers.updatePassword(id, hash);
  }

  log.info({ userId: id, changes: Object.keys(updates) }, 'User updated');
  return { user: toUserInfo(rowToUser(dbUsers.getById(id))) };
}

function deleteUser(id) {
  const row = dbUsers.getById(id);
  if (!row) return { error: 'User not found' };
  if (row.role === 'superadmin') return { error: 'Cannot delete the superadmin account' };

  dbUsers.remove(id);
  log.info({ userId: id, username: row.username }, 'User deleted');
  return { ok: true };
}

function listUsers() {
  const rows = dbUsers.getAll();
  return rows.map(function(row) {
    return toUserInfo(rowToUser(row));
  });
}

function getUser(id) {
  const row = dbUsers.getById(id);
  if (!row) return null;
  return toUserInfo(rowToUser(row));
}

// =============================================================================
// SETUP STATUS
// =============================================================================

function isSetupComplete() {
  return dbConfig.get('setup_complete') === 'true';
}

function hasSuperAdmin() {
  return dbUsers.countByRole('superadmin') > 0;
}

function completeSetup(ssoConfig) {
  // Store SSO configuration
  if (ssoConfig) {
    dbConfig.set('sso_provider', ssoConfig.provider || 'builtin');
    if (ssoConfig.provider === 'oidc') {
      dbConfig.set('sso_oidc_issuer', ssoConfig.oidcIssuer || '');
      dbConfig.set('sso_oidc_client_id', encrypt(ssoConfig.oidcClientId || ''));
      dbConfig.set('sso_oidc_client_secret', encrypt(ssoConfig.oidcClientSecret || ''));
      dbConfig.set('sso_oidc_redirect_uri', ssoConfig.oidcRedirectUri || '');
    } else if (ssoConfig.provider === 'saml') {
      dbConfig.set('sso_saml_entry_point', ssoConfig.samlEntryPoint || '');
      dbConfig.set('sso_saml_issuer', ssoConfig.samlIssuer || '');
      dbConfig.set('sso_saml_cert', encrypt(ssoConfig.samlCert || ''));
    } else if (ssoConfig.provider === 'ldap') {
      dbConfig.set('sso_ldap_url', ssoConfig.ldapUrl || '');
      dbConfig.set('sso_ldap_bind_dn', encrypt(ssoConfig.ldapBindDn || ''));
      dbConfig.set('sso_ldap_bind_password', encrypt(ssoConfig.ldapBindPassword || ''));
      dbConfig.set('sso_ldap_search_base', ssoConfig.ldapSearchBase || '');
      dbConfig.set('sso_ldap_search_filter', ssoConfig.ldapSearchFilter || '');
    }
  }

  dbConfig.set('setup_complete', 'true');
  dbConfig.set('setup_completed_at', new Date().toISOString());
  log.info({ provider: ssoConfig ? ssoConfig.provider : 'builtin' }, 'Setup completed');
}

function getSsoConfig() {
  const provider = dbConfig.get('sso_provider') || 'builtin';
  const config = { provider };

  if (provider === 'oidc') {
    config.oidcIssuer = dbConfig.get('sso_oidc_issuer') || '';
    config.oidcClientId = dbConfig.get('sso_oidc_client_id') ? '[configured]' : '';
    config.oidcRedirectUri = dbConfig.get('sso_oidc_redirect_uri') || '';
  } else if (provider === 'saml') {
    config.samlEntryPoint = dbConfig.get('sso_saml_entry_point') || '';
    config.samlIssuer = dbConfig.get('sso_saml_issuer') || '';
  } else if (provider === 'ldap') {
    config.ldapUrl = dbConfig.get('sso_ldap_url') || '';
    config.ldapSearchBase = dbConfig.get('sso_ldap_search_base') || '';
    config.ldapSearchFilter = dbConfig.get('sso_ldap_search_filter') || '';
  }

  return config;
}

// =============================================================================
// HELPERS
// =============================================================================

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    name: row.display_name || row.username,
    email: decrypt(row.email_encrypted),
    groups: safeJsonParse(row.groups, []),
    enabled: !!row.enabled,
    createdBy: row.created_by,
    lastLogin: row.last_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUserInfo(user) {
  if (!user) return null;
  return {
    sub: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    groups: user.groups,
    enabled: user.enabled,
    createdBy: user.createdBy,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
  };
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

// Lookup functions (match old users.js API)
function findByUsername(username) {
  const row = dbUsers.getByUsername(username);
  if (!row || !row.enabled) return null;
  return rowToUser(row);
}

function findById(id) {
  const row = dbUsers.getById(id);
  if (!row || !row.enabled) return null;
  return rowToUser(row);
}

module.exports = {
  init,
  authenticate,
  createUser,
  updateUser,
  deleteUser,
  listUsers,
  getUser,
  findByUsername,
  findById,
  toUserInfo,
  isSetupComplete,
  hasSuperAdmin,
  completeSetup,
  getSsoConfig,
  VALID_ROLES,
};
