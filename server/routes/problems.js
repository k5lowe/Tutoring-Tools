'use strict';

const express = require('express');
const store = require('../store/problems');
const { instantiate } = require('../lib/variants');
const { fragmentToHtml } = require('../lib/latex2html');
const { transaction } = require('../db');
const { randomSeed } = require('../lib/rng');
const { requireAdmin } = require('../middleware/admin');

/** Query strings arrive as strings; turn repeated/comma values into arrays. */
function toArray(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(toArray);
  return String(value).split(',').map((part) => part.trim()).filter(Boolean);
}

function filtersFromQuery(query) {
  return {
    q: query.q,
    subject: query.subject,
    topic: query.topic,
    subtopic: query.subtopic,
    book: query.book,
    section: query.section,
    chapter: query.chapter,
    kind: query.kind,
    tags: toArray(query.tags),
    difficulties: toArray(query.difficulties).map(Number).filter(Number.isFinite),
    difficultyMin: query.difficultyMin,
    difficultyMax: query.difficultyMax,
    excludeIds: toArray(query.excludeIds).map(Number).filter(Number.isFinite),
    includeArchived: query.includeArchived === 'true' || query.includeArchived === '1',
    archivedOnly: query.archivedOnly === 'true' || query.archivedOnly === '1',
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  };
}

/** Build one instance of a problem and attach rendered HTML for the UI. */
function preview(problem, seed) {
  const usedSeed = Number(seed) > 0 ? Math.floor(Number(seed)) : randomSeed();
  try {
    const instance = instantiate(problem, usedSeed);
    return {
      ok: true,
      seed: usedSeed,
      ...instance,
      html: {
        statement: fragmentToHtml(instance.statement),
        answer: fragmentToHtml(instance.answer),
        solution: fragmentToHtml(instance.solution),
      },
    };
  } catch (error) {
    return { ok: false, seed: usedSeed, error: error.message };
  }
}

/**
 * Attach rendered math to a problem so lists can display it instead of raw
 * LaTeX. Template problems are shown at a fixed seed so the list is stable
 * between reloads.
 */
function withHtml(problem, seed = 1) {
  let instance;
  try {
    instance = instantiate(problem, seed);
  } catch (error) {
    return { ...problem, html: { error: error.message } };
  }
  return {
    ...problem,
    html: {
      statement: fragmentToHtml(instance.statement),
      answer: fragmentToHtml(instance.answer),
      solution: fragmentToHtml(instance.solution),
    },
  };
}

function createRouter(getDb) {
  const router = express.Router();

  router.get('/facets', (req, res) => {
    res.json(store.facets(getDb(), req.libraryId));
  });

  router.get('/', (req, res) => {
    const result = store.list(getDb(), req.libraryId, filtersFromQuery(req.query));
    if (req.query.render === '1' || req.query.render === 'true') {
      result.items = result.items.map((problem) => withHtml(problem));
    }
    res.json(result);
  });

  // Export before /:id so "export" is not read as an id.
  router.get('/export', (req, res) => {
    const items = store.listAll(getDb(), req.libraryId,
      { ...filtersFromQuery(req.query), includeArchived: true });
    const payload = items.map((problem) => ({
      external_key: problem.external_key || `export-${problem.id}`,
      subject: problem.subject,
      topic: problem.topic,
      subtopic: problem.subtopic,
      difficulty: problem.difficulty,
      kind: problem.kind,
      statement: problem.statement,
      answer: problem.answer,
      solution: problem.solution,
      params: problem.params,
      tags: problem.tags,
      source_book: problem.source_book,
      source_edition: problem.source_edition,
      source_chapter: problem.source_chapter,
      source_section: problem.source_section,
      source_number: problem.source_number,
      notes: problem.notes,
    }));
    res.setHeader('Content-Disposition', 'attachment; filename="problem-bank.json"');
    res.json({ problems: payload });
  });

  /** Preview an unsaved draft, so the editor can check a template before saving. */
  router.post('/preview', (req, res) => {
    const draft = req.body && req.body.problem ? req.body.problem : req.body;
    const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 12);
    const baseSeed = Number(req.body?.seed) || randomSeed();
    const instances = [];
    for (let i = 0; i < count; i += 1) {
      instances.push(preview(draft, baseSeed + i * 7919));
    }
    res.json({ instances });
  });

  router.post('/import', requireAdmin, (req, res) => {
    const incoming = Array.isArray(req.body) ? req.body : req.body?.problems;
    if (!Array.isArray(incoming)) {
      res.status(400).json({ error: 'Expected a JSON array of problems, or { "problems": [...] }.' });
      return;
    }
    const db = getDb();
    const workspaceId = req.libraryId;
    const result = transaction(db, () => {
      let created = 0;
      let updated = 0;
      const errors = [];
      incoming.forEach((problem, index) => {
        try {
          const outcome = store.upsert(db, workspaceId, problem);
          if (outcome.created) created += 1;
          else updated += 1;
        } catch (error) {
          errors.push({ index, message: error.message });
        }
      });
      return { created, updated, errors, total: incoming.length };
    });
    res.json(result);
  });

  router.get('/:id', (req, res) => {
    const problem = store.get(getDb(), req.libraryId, req.params.id);
    if (!problem) {
      res.status(404).json({ error: 'Problem not found.' });
      return;
    }
    res.json(problem);
  });

  router.get('/:id/preview', (req, res) => {
    const problem = store.get(getDb(), req.libraryId, req.params.id);
    if (!problem) {
      res.status(404).json({ error: 'Problem not found.' });
      return;
    }
    const count = Math.min(Math.max(Number(req.query.count) || 1, 1), 12);
    const baseSeed = Number(req.query.seed) || randomSeed();
    const instances = [];
    for (let i = 0; i < count; i += 1) {
      instances.push(preview(problem, baseSeed + i * 7919));
    }
    res.json({ problem, instances });
  });

  router.post('/', requireAdmin, (req, res) => {
    const payload = req.body && req.body.problem ? req.body.problem : req.body;
    if (!payload || !String(payload.statement || '').trim()) {
      res.status(400).json({ error: 'A problem needs a statement.' });
      return;
    }
    const problem = store.create(getDb(), req.libraryId, payload);
    res.status(201).json({ problem, check: preview(problem, 1) });
  });

  router.put('/:id', requireAdmin, (req, res) => {
    const payload = req.body && req.body.problem ? req.body.problem : req.body;
    const problem = store.update(getDb(), req.libraryId, req.params.id, payload);
    if (!problem) {
      res.status(404).json({ error: 'Problem not found.' });
      return;
    }
    res.json({ problem, check: preview(problem, 1) });
  });

  router.delete('/:id', requireAdmin, (req, res) => {
    const removed = store.remove(getDb(), req.libraryId, req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Problem not found.' });
      return;
    }
    res.status(204).end();
  });

  return router;
}

module.exports = { createRouter, filtersFromQuery, toArray, preview, withHtml };
