'use strict';

const express = require('express');
const setsStore = require('../store/sets');
const problemsStore = require('../store/problems');
const { selectProblems } = require('../lib/select');
const { randomSeed } = require('../lib/rng');
const { resolveItems } = require('../lib/latex');
const { computeLabels, groupBySection } = require('../lib/numbering');
const { fragmentToHtml } = require('../lib/latex2html');
const { filtersFromQuery, toArray } = require('./problems');

/**
 * Build a set from selection criteria rather than by hand-picking problems:
 * "12 medium-to-hard problems on quadratics from Chapter 5, mixed difficulty".
 */
function generateItems(db, workspaceId, body) {
  const filters = {
    ...filtersFromQuery(body.filters || {}),
    tags: toArray((body.filters || {}).tags),
    difficulties: toArray((body.filters || {}).difficulties).map(Number).filter(Number.isFinite),
    // Selection needs the whole matching pool, not one page of it.
    limit: undefined,
    offset: undefined,
    sort: (body.filters || {}).sort || 'textbook',
  };
  const pool = problemsStore.listAll(db, workspaceId, filters);
  const { problems, shortfall } = selectProblems(pool, {
    count: body.count,
    distribution: body.distribution,
    seed: body.seed || randomSeed(),
    allowRepeats: body.allowRepeats !== false,
  });
  return {
    items: problems.map((problem, index) => ({
      problem_id: problem.id,
      position: index,
      seed: randomSeed(),
    })),
    poolSize: pool.length,
    shortfall,
  };
}

function createRouter(getDb) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ sets: setsStore.list(getDb(), req.workspaceId, req.query) });
  });

  router.post('/generate', (req, res) => {
    const db = getDb();
    const body = req.body || {};
    const { items, poolSize, shortfall } = generateItems(db, req.libraryId, body);
    if (items.length === 0) {
      res.status(422).json({
        error: 'No problems in the bank match those filters.',
        poolSize,
      });
      return;
    }
    const set = setsStore.create(db, req.workspaceId, {
      title: body.title || 'Practice set',
      subject: body.subject || (body.filters || {}).subject || '',
      numbering: body.numbering,
      start_at: body.start_at,
      versions: body.versions,
      meta: body.meta || {},
      items,
    });
    res.status(201).json({ set, poolSize, shortfall });
  });

  router.post('/', (req, res) => {
    const set = setsStore.create(getDb(), req.workspaceId, req.body || {});
    res.status(201).json({ set });
  });

  router.get('/:id', (req, res) => {
    const set = setsStore.get(getDb(), req.workspaceId, req.params.id);
    if (!set) {
      res.status(404).json({ error: 'Set not found.' });
      return;
    }
    if (req.query.render === '1' || req.query.render === 'true') {
      // Each item is shown as it will actually print: its own seed, its own
      // overrides, and the labels the current numbering mode produces.
      // Mirror the renderer exactly, grouping included, so the list on screen is
      // the order the worksheet will print in.
      const ordered = set.numbering === 'section' ? groupBySection(set.items) : set.items;
      const resolved = resolveItems(ordered);
      const labels = computeLabels(resolved, set.numbering, { startAt: set.start_at });
      set.items = resolved.map((item, index) => ({
        ...item,
        label: labels[index].label,
        heading: labels[index].heading,
        html: {
          statement: fragmentToHtml(item.statement),
          answer: fragmentToHtml(item.answer),
          solution: fragmentToHtml(item.solution),
          // Headings hold LaTeX too ("---"), so they go through the same pass.
          heading: labels[index].heading ? fragmentToHtml(labels[index].heading) : '',
        },
      }));
    }
    res.json({ set });
  });

  router.put('/:id', (req, res) => {
    const set = setsStore.update(getDb(), req.workspaceId, req.params.id, req.body || {});
    if (!set) {
      res.status(404).json({ error: 'Set not found.' });
      return;
    }
    res.json({ set });
  });

  router.delete('/:id', (req, res) => {
    if (!setsStore.remove(getDb(), req.workspaceId, req.params.id)) {
      res.status(404).json({ error: 'Set not found.' });
      return;
    }
    res.status(204).end();
  });

  router.post('/:id/duplicate', (req, res) => {
    const set = setsStore.duplicate(getDb(), req.workspaceId, req.params.id, (req.body || {}).title);
    if (!set) {
      res.status(404).json({ error: 'Set not found.' });
      return;
    }
    res.status(201).json({ set });
  });

  router.post('/:id/items', (req, res) => {
    const db = getDb();
    if (!setsStore.getBare(db, req.workspaceId, req.params.id)) {
      res.status(404).json({ error: 'Set not found.' });
      return;
    }
    const body = req.body || {};
    const ids = Array.isArray(body.problem_ids)
      ? body.problem_ids
      : toArray(body.problem_id).map(Number);
    if (ids.length === 0) {
      res.status(400).json({ error: 'Provide problem_ids.' });
      return;
    }
    res.json({ items: setsStore.addItems(db, req.workspaceId, req.params.id, ids, body.seeds || {}) });
  });

  /** Add auto-selected problems to an existing set ("give me five more like these"). */
  router.post('/:id/items/generate', (req, res) => {
    const db = getDb();
    const set = setsStore.get(db, req.workspaceId, req.params.id);
    if (!set) {
      res.status(404).json({ error: 'Set not found.' });
      return;
    }
    const body = req.body || {};
    const filters = { ...(body.filters || {}) };
    if (body.allowDuplicates !== true) {
      // Only fixed problems are excluded. A template problem already in the set
      // is still fair game: a fresh seed makes it a genuinely different problem,
      // and excluding it would empty a template-only pool and fail the request.
      filters.excludeIds = [
        ...toArray(filters.excludeIds),
        ...set.items.filter((item) => item.kind === 'static').map((item) => item.problem_id),
      ];
    }
    const { items, poolSize, shortfall } = generateItems(db, req.libraryId, { ...body, filters });
    if (items.length === 0) {
      res.status(422).json({ error: 'No further problems match those filters.', poolSize });
      return;
    }
    const seeds = Object.fromEntries(items.map((item) => [item.problem_id, item.seed]));
    res.json({
      items: setsStore.addItems(db, req.workspaceId, req.params.id,
        items.map((item) => item.problem_id), seeds),
      poolSize,
      shortfall,
    });
  });

  router.put('/:id/items', (req, res) => {
    const db = getDb();
    if (!setsStore.getBare(db, req.workspaceId, req.params.id)) {
      res.status(404).json({ error: 'Set not found.' });
      return;
    }
    const items = Array.isArray(req.body) ? req.body : (req.body || {}).items;
    if (!Array.isArray(items)) {
      res.status(400).json({ error: 'Provide an items array.' });
      return;
    }
    res.json({ items: setsStore.replaceItems(db, req.workspaceId, req.params.id, items) });
  });

  router.patch('/:id/items/:itemId', (req, res) => {
    res.json({
      items: setsStore.updateItem(getDb(), req.workspaceId, req.params.id, req.params.itemId, req.body || {}),
    });
  });

  router.delete('/:id/items/:itemId', (req, res) => {
    res.json({ items: setsStore.removeItem(getDb(), req.workspaceId, req.params.id, req.params.itemId) });
  });

  router.post('/:id/items/:itemId/move', (req, res) => {
    const to = (req.body || {}).to;
    res.json({ items: setsStore.moveItem(getDb(), req.workspaceId, req.params.id, req.params.itemId, to) });
  });

  router.post('/:id/sort', (req, res) => {
    const by = (req.body || {}).by || 'section';
    if (!Object.prototype.hasOwnProperty.call(setsStore.SORT_KEYS, by)) {
      res.status(400).json({ error: `Unknown sort key "${by}".` });
      return;
    }
    res.json({ items: setsStore.sortItems(getDb(), req.workspaceId, req.params.id, by) });
  });

  /** Fresh random draws for the template-backed problems in the set. */
  router.post('/:id/reseed', (req, res) => {
    const body = req.body || {};
    const itemIds = Array.isArray(body.item_ids) ? body.item_ids : null;
    res.json({ items: setsStore.reseed(getDb(), req.workspaceId, req.params.id, { itemIds }) });
  });

  return router;
}

module.exports = { createRouter, generateItems };
