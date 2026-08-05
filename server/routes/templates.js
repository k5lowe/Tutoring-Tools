'use strict';

const express = require('express');
const store = require('../store/templates');
const { parse } = require('../lib/mustache');

/** Catch unbalanced sections before a template is saved. */
function validate(body) {
  try {
    parse(String(body || ''));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function createRouter(getDb) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ templates: store.list(getDb(), req.workspaceId, req.query.kind) });
  });

  router.get('/:id', (req, res) => {
    const template = store.get(getDb(), req.workspaceId, req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Template not found.' });
      return;
    }
    res.json({ template });
  });

  router.post('/', (req, res) => {
    const check = validate((req.body || {}).body);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
    res.status(201).json({ template: store.create(getDb(), req.workspaceId, req.body || {}) });
  });

  router.put('/:id', (req, res) => {
    if ('body' in (req.body || {})) {
      const check = validate(req.body.body);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
    }
    const template = store.update(getDb(), req.workspaceId, req.params.id, req.body || {});
    if (!template) {
      res.status(404).json({ error: 'Template not found.' });
      return;
    }
    res.json({ template });
  });

  router.post('/:id/default', (req, res) => {
    const template = store.setDefault(getDb(), req.workspaceId, req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Template not found.' });
      return;
    }
    res.json({ template });
  });

  router.post('/:id/reset', (req, res) => {
    const template = store.reset(getDb(), req.workspaceId, req.params.id);
    if (!template) {
      res.status(400).json({ error: 'Only built-in templates can be reset.' });
      return;
    }
    res.json({ template });
  });

  router.delete('/:id', (req, res) => {
    if (!store.remove(getDb(), req.workspaceId, req.params.id)) {
      res.status(400).json({ error: 'Built-in templates cannot be deleted.' });
      return;
    }
    res.status(204).end();
  });

  return router;
}

module.exports = { createRouter };
