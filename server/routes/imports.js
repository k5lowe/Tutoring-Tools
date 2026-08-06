'use strict';

const express = require('express');
const imports = require('../store/imports');
const { transaction } = require('../db');
const { requireAdmin } = require('../middleware/admin');

/**
 * The history of bulk imports, and the way back from one.
 *
 * Owner-only throughout: what has been imported and when is not a visitor's
 * business, and undoing plainly is not.
 */
function createRouter(getDb) {
  const router = express.Router();

  router.get('/', requireAdmin, (req, res) => {
    const db = getDb();
    res.json({
      imports: imports.recent(db, req.query.limit),
      last: (() => {
        const entry = imports.lastUndoable(db);
        if (!entry) return null;
        const { createdIds, replacedRows, ...summary } = entry;
        return summary;
      })(),
    });
  });

  router.post('/:id/undo', requireAdmin, (req, res) => {
    const db = getDb();
    const result = transaction(db, () => imports.undo(db, req.params.id));
    if (!result) {
      res.status(404).json({ error: 'No such import.' });
      return;
    }
    if (result.alreadyUndone) {
      res.status(409).json({ error: 'That import has already been taken back.' });
      return;
    }
    const { createdIds, replacedRows, ...summary } = result;
    res.json(summary);
  });

  return router;
}

module.exports = { createRouter };
