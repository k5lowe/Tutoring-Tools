'use strict';

const crypto = require('node:crypto');
const { toId, DEFAULT_WORKSPACE_ID } = require('../db');

/**
 * A workspace is one tutor's private bank.
 *
 * Identity is a random 128-bit token the visitor holds in a cookie — a bearer
 * credential, not an account. Only its SHA-256 hash is stored, so a copy of the
 * database does not hand over anyone's workspace. That also means a lost token
 * cannot be recovered, which is why the UI offers the token back as a
 * bookmarkable link and an export.
 *
 * Running locally there is exactly one workspace (id 1, no token) and none of
 * this is used.
 */

const TOKEN_BYTES = 16;

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Tokens are opaque; reject anything that isn't the shape we issue. */
function looksLikeToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token);
}

function row(record) {
  if (!record) return null;
  return { ...record, id: toId(record.id) };
}

function findByToken(db, token) {
  if (!looksLikeToken(token)) return null;
  return row(
    db.prepare('SELECT * FROM workspaces WHERE token_hash = ?').get(hashToken(token)),
  );
}

function get(db, id) {
  return row(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(Number(id)));
}

/** Create a workspace and return it together with its one-time-visible token. */
function create(db, { label = '' } = {}) {
  const token = newToken();
  const result = db
    .prepare('INSERT INTO workspaces (token_hash, label) VALUES (?, ?)')
    .run(hashToken(token), String(label));
  return { workspace: get(db, toId(result.lastInsertRowid)), token };
}

function touch(db, id) {
  db.prepare("UPDATE workspaces SET last_seen_at = datetime('now') WHERE id = ?").run(Number(id));
}

function count(db) {
  return toId(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n);
}

module.exports = {
  findByToken, get, create, touch, count, newToken, hashToken, looksLikeToken,
  DEFAULT_WORKSPACE_ID,
};
