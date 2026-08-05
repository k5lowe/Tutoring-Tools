'use strict';

const path = require('node:path');
const express = require('express');

const templatesStore = require('./store/templates');
const problemsRoutes = require('./routes/problems');
const setsRoutes = require('./routes/sets');
const templatesRoutes = require('./routes/templates');
const renderRoutes = require('./routes/render');
const { MODES } = require('./lib/numbering');
const { DISTRIBUTIONS } = require('./lib/select');
const { helpers } = require('./lib/expr');
const { katexStylesheetPath } = require('./lib/latex2html');
const { workspaceMiddleware, seedTemplates } = require('./middleware/workspace');
const { createLimiter } = require('./middleware/ratelimit');
const { seedProblems } = require('../scripts/seed');
const { DEFAULT_WORKSPACE_ID } = require('./db');
const pdf = require('./lib/pdf');

/**
 * Build the Express app around an already-open database handle, so tests can
 * run the whole stack against an in-memory database.
 */
/**
 * @param {object} db
 * @param {object} [options]
 * @param {boolean} [options.multiUser] a private workspace per visitor
 * @param {boolean} [options.pdfEnabled] compile LaTeX server-side. Off by
 *   default when hosting, because templates are user-written LaTeX and an
 *   engine can be made to read files off the host. ALLOW_PDF=1 overrides.
 */
function createApp(db, options = {}) {
  const multiUser = options.multiUser ?? (process.env.MULTI_USER === '1');
  // Derived from the effective mode, not the environment variable: an app
  // constructed with multiUser: true must default to PDF off too.
  const pdfEnabled = options.pdfEnabled ?? (process.env.ALLOW_PDF === '1' || !multiUser);
  const getDb = () => db;
  templatesStore.ensureBuiltins(db, DEFAULT_WORKSPACE_ID);

  const app = express();
  app.disable('x-powered-by');
  // Behind a hosting proxy, so req.secure reflects the original scheme.
  if (multiUser) app.set('trust proxy', 1);
  app.use(express.json({ limit: '8mb' }));

  // Creating a workspace writes a whole starter bank, so cap how fast one
  // address can do it. Visitors with an existing workspace are unaffected.
  const workspaceLimiter = multiUser
    ? createLimiter({
      windowMs: 60 * 60 * 1000,
      max: Number(process.env.NEW_WORKSPACES_PER_HOUR) || 20,
    })
    : null;

  // Everything below this point knows whose bank it is looking at.
  app.use(workspaceMiddleware({
    getDb,
    multiUser,
    limiter: workspaceLimiter,
    onCreate: (database, workspaceId) => {
      seedTemplates(database, workspaceId);
      seedProblems(database, workspaceId);
    },
  }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  /**
   * The visitor's own workspace. In multi-user mode the token is returned so the
   * UI can offer a bookmarkable link — losing the cookie otherwise loses the bank.
   */
  app.get('/api/workspace', (req, res) => {
    res.json({
      multiUser,
      id: req.workspaceId,
      token: multiUser ? req.workspaceToken : null,
    });
  });

  /** Everything the UI needs to populate its controls. */
  app.get('/api/meta', (req, res) => {
    res.json({
      numberingModes: MODES,
      distributions: DISTRIBUTIONS,
      documentKinds: renderRoutes.DOCUMENT_KINDS,
      difficulties: [1, 2, 3, 4, 5],
      exprHelpers: helpers,
      multiUser,
      pdf: { available: pdfEnabled && pdf.isAvailable(), disabled: !pdfEnabled },
    });
  });

  app.use('/api/problems', problemsRoutes.createRouter(getDb));
  app.use('/api/sets', setsRoutes.createRouter(getDb));
  app.use('/api/templates', templatesRoutes.createRouter(getDb));
  app.use('/api/render', renderRoutes.createRouter(getDb, { pdfEnabled }));
  app.use('/', renderRoutes.createDocumentRouter(getDb, { pdfEnabled }));

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
