// SSO User Store — delegates to DB-backed user-store.js
//
// This file maintains the same API surface as before:
//   authenticate(username, password) → user or null
//   findByUsername(username) → user or null
//   findById(id) → user or null
//   toUserInfo(user) → sanitized object
//
// All actual logic lives in user-store.js (AES-256-GCM encryption, Argon2id hashing, DB CRUD).

const userStore = require('./user-store');

module.exports = {
  authenticate: userStore.authenticate,
  findByUsername: userStore.findByUsername,
  findById: userStore.findById,
  toUserInfo: userStore.toUserInfo,
};
