'use strict';

const express = require('express');
const store = require('../store/problems');
const imports = require('../store/imports');
const { instantiate } = require('../lib/variants');
const { fragmentToHtml } = require('../lib/latex2html');
const { transaction } = require('../db');
const { randomSeed } = require('../lib/rng');
const { requireAdmin } = require('../middleware/admin');
const { parseQuestions } = require('../lib/quickparse');

/** How many parsed questions get a rendered preview. See POST /parse. */
const PREVIEW_LIMIT = 60;

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
    res.json(store.facets(getDb()));
  });

  router.get('/', (req, res) => {
    const result = store.list(getDb(), filtersFromQuery(req.query));
    if (req.query.render === '1' || req.query.render === 'true') {
      result.items = result.items.map((problem) => withHtml(problem));
    }
    res.json(result);
  });

  // Export before /:id so "export" is not read as an id.
  router.get('/export', (req, res) => {
    const items = store.listAll(getDb(), { ...filtersFromQuery(req.query), includeArchived: true });
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

  /**
   * Dry run of the plain-text format: parse, render a preview of each question,
   * and report every mistake with its line number. Nothing is written, so the
   * author can see exactly what they are about to add.
   *
   * Every question is checked, but only the first `PREVIEW_LIMIT` are rendered.
   * A batch of several hundred is the point of this format, and rendering all of
   * them would cost far more than it tells the author, who is going to read the
   * first few and scroll past the rest.
   */
  router.post('/parse', requireAdmin, (req, res) => {
    const { questions, errors } = parseQuestions((req.body || {}).text);
    res.json({
      errors,
      count: questions.length,
      previewed: Math.min(questions.length, PREVIEW_LIMIT),
      questions: questions.map((question, index) => (index < PREVIEW_LIMIT
        ? { ...question, preview: preview(question, 1) }
        : question)),
    });
  });

  router.post('/import', requireAdmin, (req, res) => {
    const incoming = Array.isArray(req.body) ? req.body : req.body?.problems;
    if (!Array.isArray(incoming)) {
      res.status(400).json({ error: 'Expected a JSON array of problems, or { "problems": [...] }.' });
      return;
    }
    const source = req.body && req.body.source === 'json' ? 'json' : 'text';
    const db = getDb();
    const result = transaction(db, () => {
      const createdIds = [];
      const replaced = [];
      let updated = 0;
      const errors = [];
      incoming.forEach((problem, index) => {
        try {
          const outcome = store.upsert(db, problem);
          if (outcome.created) createdIds.push(outcome.problem.id);
          else {
            updated += 1;
            replaced.push(outcome.previous);
          }
        } catch (error) {
          errors.push({ index, message: error.message });
        }
      });
      // Recorded inside the same transaction: a batch that rolls back must not
      // leave behind an undo entry pointing at rows that were never written.
      const entry = createdIds.length + replaced.length > 0
        ? imports.record(db, { source, createdIds, replaced })
        : null;
      return {
        created: createdIds.length,
        updated,
        errors,
        total: incoming.length,
        importId: entry ? entry.id : null,
      };
    });
    res.json(result);
  });

  /**
   * Change every question the current filter matches.
   *
   * The filter is the one the author is already looking at, so the count they
   * confirmed against is the count that changes. `expect` carries that number
   * back and the request is refused if the bank no longer agrees — a filter can
   * match something different by the time the form is submitted.
   */
  router.post('/bulk', requireAdmin, (req, res) => {
    const { filters, changes, expect } = req.body || {};
    const db = getDb();
    const parsed = filtersFromQuery(filters || {});
    const matched = store.count(db, parsed);

    if (expect != null && Number(expect) !== matched) {
      res.status(409).json({
        error: `That filter matched ${expect} questions when you opened the form and `
          + `matches ${matched} now. Nothing was changed — check the filter and try again.`,
        matched,
      });
      return;
    }
    const result = transaction(db, () => store.bulkUpdate(db, parsed, changes || {}));
    res.json(result);
  });

  /**
   * Delete every question the current filter matches. `expect` is required
   * here, not optional: this is the one action in the app that cannot be undone,
   * so it only runs against a number the author has actually seen.
   */
  router.post('/bulk-delete', requireAdmin, (req, res) => {
    const { filters, expect } = req.body || {};
    if (expect == null || !Number.isFinite(Number(expect))) {
      res.status(400).json({ error: 'Deleting in bulk needs the number of questions you expect to delete.' });
      return;
    }
    const db = getDb();
    const parsed = filtersFromQuery(filters || {});
    const matched = store.count(db, parsed);
    if (Number(expect) !== matched) {
      res.status(409).json({
        error: `That filter matched ${expect} questions a moment ago and matches ${matched} now. `
          + 'Nothing was deleted.',
        matched,
      });
      return;
    }
    const deleted = transaction(db, () => store.bulkDelete(db, parsed));
    res.json({ deleted });
  });

  router.get('/:id', (req, res) => {
    const problem = store.get(getDb(), req.params.id);
    if (!problem) {
      res.status(404).json({ error: 'Problem not found.' });
      return;
    }
    res.json(problem);
  });

  router.get('/:id/preview', (req, res) => {
    const problem = store.get(getDb(), req.params.id);
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
    const problem = store.create(getDb(), payload);
    res.status(201).json({ problem, check: preview(problem, 1) });
  });

  router.put('/:id', requireAdmin, (req, res) => {
    const payload = req.body && req.body.problem ? req.body.problem : req.body;
    const problem = store.update(getDb(), req.params.id, payload);
    if (!problem) {
      res.status(404).json({ error: 'Problem not found.' });
      return;
    }
    res.json({ problem, check: preview(problem, 1) });
  });

  router.delete('/:id', requireAdmin, (req, res) => {
    const removed = store.remove(getDb(), req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Problem not found.' });
      return;
    }
    res.status(204).end();
  });

  return router;
}

module.exports = { createRouter, filtersFromQuery, toArray, preview, withHtml };
