'use strict';

const crypto = require('node:crypto');

/** Minimal cookie header parser — the only cookie in play is the admin session. */
function parseCookies(header) {
  const jar = {};
  if (!header) return jar;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in jar) continue;
    try {
      jar[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed cookie value is simply ignored.
    }
  }
  return jar;
}

/**
 * Who is allowed to change the problem bank.
 *
 * The bank is a curated library: visitors read it, one owner writes it. Running
 * locally the owner is simply whoever is at the keyboard, so everything is
 * unlocked. Hosted, writing requires unlocking with ADMIN_KEY.
 *
 * Sessions are random tokens held in memory rather than the key itself in a
 * cookie, so the secret never leaves the server and a restart signs the owner
 * out. With no ADMIN_KEY set, a hosted bank simply cannot be edited — which is
 * the safe way to fail.
 */

const COOKIE_NAME = 'tt_admin';
const TOKEN_BYTES = 24;
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function timingSafeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  // timingSafeEqual throws on a length mismatch, so compare digests instead:
  // equal-length inputs, and the comparison itself stays constant-time.
  const leftHash = crypto.createHash('sha256').update(left).digest();
  const rightHash = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function createAdminSessions({ maxAgeMs = SESSION_MAX_AGE_MS, now = Date.now } = {}) {
  const issued = new Map();

  return {
    issue() {
      const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
      issued.set(token, now() + maxAgeMs);
      return token;
    },
    valid(token) {
      if (!token) return false;
      const expires = issued.get(token);
      if (!expires) return false;
      if (expires < now()) {
        issued.delete(token);
        return false;
      }
      return true;
    },
    revoke(token) {
      issued.delete(token);
    },
    get size() {
      return issued.size;
    },
  };
}

function serialiseCookie(value, { secure, maxAge }) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function isSecure(req) {
  if (req.secure) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  return typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https';
}

/**
 * Marks each request with `req.isAdmin`.
 *
 * @param {object} options
 * @param {boolean} options.multiUser        hosted, so the bank needs protecting
 * @param {string}  [options.adminKey]       shared secret, from ADMIN_KEY
 * @param {object}  options.sessions         createAdminSessions()
 */
function adminMiddleware({ multiUser, adminKey, sessions }) {
  return function resolveAdmin(req, res, next) {
    if (!multiUser) {
      // Local: you are on your own machine, editing your own bank.
      req.isAdmin = true;
      req.adminPossible = true;
      next();
      return;
    }
    req.adminPossible = Boolean(adminKey);
    const jar = parseCookies(req.headers.cookie);
    req.isAdmin = Boolean(adminKey) && sessions.valid(jar[COOKIE_NAME]);
    next();
  };
}

/** Refuse a write from anyone who is not the owner. */
function requireAdmin(req, res, next) {
  if (req.isAdmin) {
    next();
    return;
  }
  res.status(403).json({
    error: 'This problem bank is read-only. Sign in as the owner to change it.',
  });
}

/** POST /unlock, POST /lock and GET / for the admin session. */
function createAdminRouter({ multiUser, adminKey, sessions, limiter }) {
  const express = require('express');
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({
      isAdmin: Boolean(req.isAdmin),
      // Whether signing in is even possible, so the UI can hide the prompt.
      available: Boolean(req.adminPossible),
      required: Boolean(multiUser),
    });
  });

  router.post('/unlock', (req, res) => {
    if (!multiUser) {
      res.json({ isAdmin: true, available: true });
      return;
    }
    if (!adminKey) {
      res.status(503).json({
        error: 'No owner key is configured on this server, so the bank cannot be edited.',
      });
      return;
    }
    if (limiter && !limiter.take(req.ip || 'unknown')) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    const offered = (req.body || {}).key;
    if (typeof offered !== 'string' || !timingSafeEquals(offered, adminKey)) {
      res.status(401).json({ error: 'That key is not right.' });
      return;
    }
    const token = sessions.issue();
    res.setHeader('Set-Cookie', serialiseCookie(token, {
      secure: isSecure(req),
      maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
    }));
    res.json({ isAdmin: true, available: true });
  });

  router.post('/lock', (req, res) => {
    const jar = parseCookies(req.headers.cookie);
    if (jar[COOKIE_NAME]) sessions.revoke(jar[COOKIE_NAME]);
    res.setHeader('Set-Cookie', serialiseCookie('', { secure: isSecure(req), maxAge: 0 }));
    res.json({ isAdmin: !multiUser, available: Boolean(req.adminPossible) });
  });

  return router;
}

module.exports = {
  adminMiddleware, requireAdmin, createAdminRouter, createAdminSessions, parseCookies,
  timingSafeEquals, COOKIE_NAME,
};
