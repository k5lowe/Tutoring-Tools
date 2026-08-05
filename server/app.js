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
const pdf = require('./lib/pdf');

/**
 * Build the Express app around an already-open database handle, so tests can
 * run the whole stack against an in-memory database.
 */
function createApp(db) {
  const getDb = () => db;
  templatesStore.ensureBuiltins(db);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  /** Everything the UI needs to populate its controls. */
  app.get('/api/meta', (req, res) => {
    res.json({
      numberingModes: MODES,
      distributions: DISTRIBUTIONS,
      documentKinds: renderRoutes.DOCUMENT_KINDS,
      difficulties: [1, 2, 3, 4, 5],
      exprHelpers: helpers,
      pdf: { available: pdf.isAvailable() },
    });
  });

  app.use('/api/problems', problemsRoutes.createRouter(getDb));
  app.use('/api/sets', setsRoutes.createRouter(getDb));
  app.use('/api/templates', templatesRoutes.createRouter(getDb));
  app.use('/api/render', renderRoutes.createRouter(getDb));
  app.use('/', renderRoutes.createDocumentRouter(getDb));

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
