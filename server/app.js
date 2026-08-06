'use strict';

const path = require('node:path');
const express = require('express');

const problemsRoutes = require('./routes/problems');
const importsRoutes = require('./routes/imports');
const snapshotsRoutes = require('./routes/snapshots');
const { helpers } = require('./lib/expr');
const { katexStylesheetPath } = require('./lib/latex2html');
const { createLimiter } = require('./middleware/ratelimit');
const {
  adminMiddleware, createAdminRouter, createAdminSessions,
} = require('./middleware/admin');

/**
 * The question bank as a web app.
 *
 * There is one bank. Everyone reads it; only the owner writes it. Locally that
 * is you, so nothing is locked. Hosted (`MULTI_USER=1`) editing needs the
 * `ADMIN_KEY`, and visitors get a read-only view with no account, no cookie and
 * nothing of their own to lose.
 *
 * @param {object} db
 * @param {object} [options]
 * @param {boolean} [options.multiUser]   hosted, so the bank needs protecting
 * @param {string}  [options.adminKey]    shared secret that unlocks editing
 * @param {string}  [options.snapshotDir] where backups go; null disables them
 */
function createApp(db, options = {}) {
  const multiUser = options.multiUser ?? (process.env.MULTI_USER === '1');
  const adminKey = options.adminKey ?? process.env.ADMIN_KEY ?? '';
  // Undefined means "not configured by the caller", which is how the tests get
  // an app that writes no files. The server passes a real directory.
  const snapshotDir = options.snapshotDir ?? null;
  const getDb = () => db;

  const app = express();
  app.disable('x-powered-by');
  // Behind a hosting proxy, so req.secure reflects the original scheme.
  if (multiUser) app.set('trust proxy', 1);
  app.use(express.json({ limit: '8mb' }));

  // Guessing the owner key should be slow, and the health check must never be
  // caught by the limiter or the platform will restart a healthy service.
  const adminSessions = createAdminSessions();
  const unlockLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
  app.use(adminMiddleware({ multiUser, adminKey, sessions: adminSessions }));
  app.use('/api/admin', createAdminRouter({
    multiUser, adminKey, sessions: adminSessions, limiter: unlockLimiter,
  }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  /** Everything the UI needs to set itself up. */
  app.get('/api/meta', (req, res) => {
    res.json({
      difficulties: [1, 2, 3, 4, 5],
      exprHelpers: helpers,
      multiUser,
      canEditBank: Boolean(req.isAdmin),
      adminAvailable: Boolean(req.adminPossible),
    });
  });

  app.use('/api/problems', problemsRoutes.createRouter(getDb, { snapshotDir }));
  app.use('/api/imports', importsRoutes.createRouter(getDb));
  app.use('/api/snapshots', snapshotsRoutes.createRouter(getDb, { snapshotDir }));

  // KaTeX ships its own fonts; serving the whole dist folder keeps the relative
  // font URLs in katex.min.css working, and keeps the app usable offline.
  app.use('/vendor/katex', express.static(path.dirname(katexStylesheetPath()), {
    maxAge: '1y',
    immutable: true,
  }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
      return;
    }
    res.status(404).type('text').send('Not found');
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((error, req, res, next) => {
    const status = error.status || error.statusCode || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.message || 'Unexpected server error.' });
  });

  return app;
}

module.exports = { createApp };
