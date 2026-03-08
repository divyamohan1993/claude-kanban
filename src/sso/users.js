// SSO User Store — isolated identity database.
//
// Production path: replace with LDAP, OIDC userinfo, or database lookup.
// This file is the ONLY place users are defined. Delete src/sso/ to remove.
//
// Passwords hashed with Argon2id (memory-hard, quantum-resistant).
// Hashes computed asynchronously at module load via _ready promise.

const argon2 = require('argon2');

// Argon2id params — OWASP recommended minimum (memoryCost=64MB, timeCost=3, parallelism=4)
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 };

// Dummy hash used for timing-safe rejection when username doesn't exist.
// Prevents attacker from distinguishing "user not found" vs "wrong password" via response timing.
let DUMMY_HASH = '';

// Passwords from env vars (ADMIN_PASSWORD, USER_PASSWORD).
// Falls back to defaults with a loud warning if not set.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const USER_PASSWORD = process.env.USER_PASSWORD || 'user';

const USERS = [
  {
    id: 'admin-001',
    username: 'admin',
    passwordHash: '',
    role: 'admin',
    name: 'Admin',
    email: 'admin@localhost',
    groups: ['administrators', 'users'],
    enabled: true,
  },
  {
    id: 'user-001',
    username: 'user',
    passwordHash: '',
    role: 'user',
    name: 'User',
    email: 'user@localhost',
    groups: ['users'],
    enabled: true,
  },
];

// Hash passwords asynchronously at module load.
// authenticate() awaits this before first use — zero blocking.
const _ready = (async function() {
  USERS[0].passwordHash = await argon2.hash(ADMIN_PASSWORD, ARGON2_OPTS);
  USERS[1].passwordHash = await argon2.hash(USER_PASSWORD, ARGON2_OPTS);
  DUMMY_HASH = await argon2.hash('dummy-timing-safe', ARGON2_OPTS);
  // Warn loudly if using default credentials
  if (!process.env.ADMIN_PASSWORD || !process.env.USER_PASSWORD) {
    const msg = '[SECURITY] Using default credentials. Set ADMIN_PASSWORD and USER_PASSWORD in .env for production.';
    console.error('\x1b[31m\x1b[1m' + msg + '\x1b[0m');
  }
})();

function findByUsername(username) {
  for (let i = 0; i < USERS.length; i++) {
    if (USERS[i].username === username && USERS[i].enabled) return USERS[i];
  }
  return null;
}

function findById(id) {
  for (let i = 0; i < USERS.length; i++) {
    if (USERS[i].id === id && USERS[i].enabled) return USERS[i];
  }
  return null;
}

async function authenticate(username, password) {
  await _ready;

  const user = findByUsername(username);
  if (user) {
    try {
      const valid = await argon2.verify(user.passwordHash, password);
      if (valid) return user;
    } catch (_) {}
    return null;
  }

  // Username not found — run dummy verify to prevent timing oracle.
  // Attacker cannot distinguish "no such user" from "wrong password" via response time.
  try { await argon2.verify(DUMMY_HASH, password); } catch (_) {}
  return null;
}

// Return sanitized user info (no password hash)
function toUserInfo(user) {
  if (!user) return null;
  return {
    sub: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    groups: user.groups,
  };
}

module.exports = {
  authenticate: authenticate,
  findByUsername: findByUsername,
  findById: findById,
  toUserInfo: toUserInfo,
};
