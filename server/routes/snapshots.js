'use strict';

const path = require('node:path');
const express = require('express');
const snapshots = require('../lib/snapshots');
const { requireAdmin } = require('../middleware/admin');

/**
 * Backups, seen from the app.
 *
 * Listing and downloading are here; restoring is not. Swapping the database out
 * from under a running server is not something to expose behind a button — it
 * needs the server stopped, so it lives in `npm run restore` where that can be
 * enforced. Owner-only throughout: a snapshot is the whole bank in one file.
 */
function createRouter(getDb, { snapshotDir = null } = {}) {
  const router = express.Router();

  router.get('/', requireAdmin, (req, res) => {
    if (!snapshotDir) {
      res.json({ enabled: false, snapshots: [], last: null });
      return;
    }
    const all = snapshots.list(snapshotDir);
    res.json({
      enabled: true,
      last: all[0] || null,
      snapshots: all.slice(0, 50),
    });
  });

  /** Take one now — for just before something you are nervous about. */
  router.post('/', requireAdmin, (req, res) => {
    if (!snapshotDir) {
      res.status(503).json({ error: 'Snapshots are switched off for this server.' });
      return;
    }
    const result = snapshots.take(getDb(), { dir: snapshotDir, reason: 'manual' });
    if (!result || result.error) {
      res.status(500).json({ error: result ? result.error : 'Could not write a snapshot.' });
      return;
    }
    snapshots.prune(snapshotDir);
    res.status(201).json(result);
  });

  /**
   * Download one. This is how a snapshot gets somewhere other than the disk it
   * was written to, which is the only failure the local copies cannot cover.
   */
  router.get('/:name', requireAdmin, (req, res) => {
    if (!snapshotDir) {
      res.status(404).json({ error: 'Snapshots are switched off for this server.' });
      return;
    }
    // Parsed rather than joined: the name has to look exactly like a snapshot,
    // which leaves no room for a path to climb out of the directory.
    const entry = snapshots.parseName(path.basename(req.params.name));
    if (!entry) {
      res.status(404).json({ error: 'No such snapshot.' });
      return;
    }
    res.download(path.join(snapshotDir, entry.name), entry.name, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'No such snapshot.' });
    });
  });

  return router;
}

module.exports = { createRouter };
