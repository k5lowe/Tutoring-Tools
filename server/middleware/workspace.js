'use strict';

const workspaces = require('../store/workspaces');
const templates = require('../store/templates');
const { DEFAULT_WORKSPACE_ID, LIBRARY_WORKSPACE_ID } = require('../db');

/**
 * Decides whose bank a request is looking at, and puts it on `req.workspaceId`.
 *
 * Single-user (the default, and how the app runs on a tutor's own machine):
 * every request is workspace 1. No cookies, no behaviour change.
 *
 * Multi-user (set MULTI_USER=1 when hosting): the visitor's cookie carries a
 * random token identifying their workspace. A visitor without a valid one gets
 * a fresh workspace, seeded with the starter bank, and the cookie to match.
 */

const COOKIE_NAME = 'tt_workspace';
const COOKIE_MAX_AGE_DAYS = 730;

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

function serialiseCookie(name, value, { secure }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE_DAYS * 24 * 60 * 60}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** True when the request reached us over HTTPS, directly or via a proxy. */
function isSecure(req) {
  if (req.secure) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  return typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https';
}

/**
 * Endpoints that say something about the server rather than about a bank.
 * These must never mint a workspace or be refused by the creation limiter —
 * a rate-limited /api/health would fail the platform's health check and put
 * the service into a restart loop.
 */
const WORKSPACE_FREE = new Set(['/api/health', '/api/meta', '/api/render/pdf-status']);

/**
 * Requests that genuinely operate on a bank. Static assets do not, so a crawler
 * pulling stylesheets never mints workspaces; the first real /api call does.
 */
function needsWorkspace(path) {
  if (WORKSPACE_FREE.has(path)) return false;
  // Signing in as the owner is about the library, not about a visitor's
  // workspace — and it must not let someone burn the creation limit.
  if (path.startsWith('/api/admin')) return false;
  return path.startsWith('/api/') || path.startsWith('/print/') || path.startsWith('/download/');
}

/**
 * @param {object} options
 * @param {Function} options.getDb
 * @param {boolean} options.multiUser
 * @param {Function} [options.onCreate] called with (db, workspaceId) for a new workspace
 * @param {object} [options.limiter] createLimiter() guarding workspace creation
 */
function workspaceMiddleware({ getDb, multiUser, onCreate, limiter }) {
  return function resolveWorkspace(req, res, next) {
    const db = getDb();

    // Problems are always read from the shared library.
    req.libraryId = LIBRARY_WORKSPACE_ID;

    if (!multiUser) {
      req.workspaceId = DEFAULT_WORKSPACE_ID;
      next();
      return;
    }

    try {
      // A token in the query string lets someone restore a workspace on a new
      // device or browser from a bookmarked link.
      const jar = parseCookies(req.headers.cookie);
      const offered = (typeof req.query.w === 'string' && req.query.w) || jar[COOKIE_NAME];

      let workspace = offered ? workspaces.findByToken(db, offered) : null;
      let token = workspace ? offered : null;

      if (!workspace && !needsWorkspace(req.path)) {
        // Serving a static file to someone with no workspace: nothing to scope.
        req.workspaceId = null;
        next();
        return;
      }

      if (!workspace) {
        if (limiter && !limiter.take(req.ip || 'unknown')) {
          res.status(429).json({
            error: 'Too many new workspaces from this address. Try again later, '
              + 'or open your existing workspace link.',
          });
          return;
        }
        const created = workspaces.create(db);
        workspace = created.workspace;
        token = created.token;
        if (onCreate) onCreate(db, workspace.id);
      }

      // Re-send the cookie on every request so its expiry keeps rolling forward
      // and a link-restored workspace sticks in this browser.
      res.setHeader('Set-Cookie', serialiseCookie(COOKIE_NAME, token, { secure: isSecure(req) }));

      workspaces.touch(db, workspace.id);
      req.workspaceId = workspace.id;
      req.workspaceToken = token;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Give a brand-new workspace the shipped templates. */
function seedTemplates(db, workspaceId) {
  templates.ensureBuiltins(db, workspaceId);
}

module.exports = {
  workspaceMiddleware, seedTemplates, parseCookies, needsWorkspace, COOKIE_NAME,
};
