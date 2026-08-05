'use strict';

const express = require('express');
const setsStore = require('../store/sets');
const problemsStore = require('../store/problems');
const templatesStore = require('../store/templates');
const { buildDocument, combineDocuments, filenameFor, slugify, versionLabel } = require('../lib/latex');
const { buildPrintPage } = require('../lib/htmldoc');
const pdf = require('../lib/pdf');

const DOCUMENT_KINDS = ['practice', 'notes', 'answers'];
const PRINT_KINDS = [...DOCUMENT_KINDS, 'solutions'];

function parseKind(value, allowed = DOCUMENT_KINDS) {
  return allowed.includes(value) ? value : allowed[0];
}

/**
 * `version` accepts a letter (A, B, ...) or a 0-based index.
 * Out-of-range values clamp to the last version rather than erroring.
 */
function parseVersion(value, versions = 1) {
  if (value == null || value === '') return 0;
  const text = String(value).trim();
  let index;
  if (/^[A-Za-z]$/.test(text)) {
    index = text.toUpperCase().charCodeAt(0) - 65;
  } else {
    index = Math.floor(Number(text));
  }
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(index, Math.max(0, versions - 1));
}

/**
 * Turn an unsaved payload into the same shape a stored set has, so previews of
 * an in-progress build go through exactly the same renderer.
 */
function adHocSet(db, payload = {}) {
  const rawItems = Array.isArray(payload.items) && payload.items.length > 0
    ? payload.items
    : (payload.problem_ids || []).map((id, index) => ({ problem_id: id, position: index }));

  const problems = problemsStore.getMany(db, rawItems.map((item) => item.problem_id));
  const byId = new Map(problems.map((problem) => [problem.id, problem]));

  const items = rawItems
    .map((item, index) => {
      const problem = byId.get(Number(item.problem_id));
      if (!problem) return null;
      return {
        ...problem,
        problem_id: problem.id,
        item_id: -(index + 1),
        position: index,
        // Deterministic default so the worksheet and its key agree.
        seed: Number(item.seed) > 0 ? Math.floor(Number(item.seed)) : 1 + index * 7919,
        label_override: String(item.label_override || ''),
        override_statement: String(item.override_statement || ''),
        override_answer: String(item.override_answer || ''),
        override_solution: String(item.override_solution || ''),
      };
    })
    .filter(Boolean);

  const set = {
    id: null,
    title: payload.title || 'Untitled set',
    subject: payload.subject || '',
    numbering: payload.numbering || 'sequential',
    start_at: Number(payload.start_at) || 1,
    versions: Math.min(26, Math.max(1, Number(payload.versions) || 1)),
    meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {},
  };
  return { set, items };
}

/** Render one document, resolving the template from the request. */
function renderOne(db, { set, items, kind, templateId, versionIndex }) {
  const template = templatesStore.resolve(db, { id: templateId, kind });
  if (!template) {
    const error = new Error(`No ${kind} template is configured.`);
    error.status = 500;
    throw error;
  }
  const built = buildDocument({
    set,
    items,
    templateBody: template.body,
    kind,
    versionIndex,
    versions: set.versions,
  });
  return { ...built, template: { id: template.id, name: template.name, kind: template.kind } };
}

function loadSet(db, id) {
  const set = setsStore.get(db, id);
  if (!set) {
    const error = new Error('Set not found.');
    error.status = 404;
    throw error;
  }
  return { set, items: set.items };
}

/** Expand `kinds`/`versions` query params into the list of documents to build. */
function expandRequest(query, versions) {
  const kinds = String(query.kinds || query.kind || 'practice')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => DOCUMENT_KINDS.includes(value));
  const kindList = kinds.length > 0 ? kinds : ['practice'];

  const allVersions = String(query.versions || '') === 'all';
  const versionList = allVersions
    ? Array.from({ length: versions }, (unused, index) => index)
    : [parseVersion(query.version, versions)];

  return { kindList, versionList };
}

function createRouter(getDb) {
  const router = express.Router();

  router.get('/pdf-status', (req, res) => {
    const engine = pdf.detectEngine({ refresh: req.query.refresh === '1' });
    res.json({ available: Boolean(engine.command), engine: engine.command || null });
  });

  /** JSON render of a saved set: LaTeX source plus the printable HTML. */
  router.get('/sets/:id', (req, res) => {
    const db = getDb();
    const { set, items } = loadSet(db, req.params.id);
    const kind = parseKind(req.query.kind);
    const versionIndex = parseVersion(req.query.version, set.versions);
    const built = renderOne(db, {
      set, items, kind, templateId: req.query.template, versionIndex,
    });
    res.json({
      kind,
      versionIndex,
      versionLabel: set.versions > 1 ? versionLabel(versionIndex) : '',
      template: built.template,
      latex: built.latex,
      html: buildPrintPage(built.context, { kind, warnings: built.warnings, standalone: false }),
      warnings: built.warnings,
      filename: filenameFor(set, kind, versionIndex, set.versions),
      count: built.context.count,
    });
  });

  /** Same, for a set that has not been saved yet. */
  router.post('/preview', (req, res) => {
    const db = getDb();
    const payload = (req.body || {}).set || req.body || {};
    const { set, items } = adHocSet(db, payload);
    if (items.length === 0) {
      res.status(422).json({ error: 'Add at least one problem to preview a set.' });
      return;
    }
    const kind = parseKind((req.body || {}).kind || req.query.kind);
    const versionIndex = parseVersion((req.body || {}).version, set.versions);
    const built = renderOne(db, {
      set, items, kind, templateId: (req.body || {}).template_id, versionIndex,
    });
    res.json({
      kind,
      versionIndex,
      template: built.template,
      latex: built.latex,
      html: buildPrintPage(built.context, { kind, warnings: built.warnings, standalone: false }),
      warnings: built.warnings,
      count: built.context.count,
    });
  });

  return router;
}

/**
 * Routes that return whole documents rather than JSON: the standalone print
 * page and the .tex / .pdf downloads.
 */
function createDocumentRouter(getDb) {
  const router = express.Router();

  router.get('/print/:id', (req, res) => {
    const db = getDb();
    const { set, items } = loadSet(db, req.params.id);
    const kind = parseKind(req.query.kind, PRINT_KINDS);
    const versionIndex = parseVersion(req.query.version, set.versions);
    // 'solutions' is HTML-only; it reuses the notes template's structure.
    const documentKind = kind === 'solutions' ? 'notes' : kind;
    const built = renderOne(db, {
      set, items, kind: documentKind, templateId: req.query.template, versionIndex,
    });
    const query = new URLSearchParams({ kind: documentKind });
    if (set.versions > 1) query.set('version', versionLabel(versionIndex));
    res.type('html').send(buildPrintPage(built.context, {
      kind,
      warnings: built.warnings,
      downloadHref: `/download/${set.id}/tex?${query.toString()}`,
    }));
  });

  router.get('/download/:id/tex', (req, res) => {
    const db = getDb();
    const { set, items } = loadSet(db, req.params.id);
    const { kindList, versionList } = expandRequest(req.query, set.versions);

    const documents = [];
    for (const versionIndex of versionList) {
      for (const kind of kindList) {
        documents.push(renderOne(db, {
          set, items, kind, templateId: req.query.template, versionIndex,
        }).latex);
      }
    }

    const single = documents.length === 1;
    const latex = single ? documents[0] : combineDocuments(documents);
    const filename = single
      ? filenameFor(set, kindList[0], versionList[0], set.versions)
      : `${slugify(set.title)}-all.tex`;

    res.setHeader('Content-Type', 'application/x-tex; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(latex);
  });

  router.get('/download/:id/pdf', async (req, res, next) => {
    const db = getDb();
    try {
      const { set, items } = loadSet(db, req.params.id);
      const { kindList, versionList } = expandRequest(req.query, set.versions);

      const documents = [];
      for (const versionIndex of versionList) {
        for (const kind of kindList) {
          documents.push(renderOne(db, {
            set, items, kind, templateId: req.query.template, versionIndex,
          }).latex);
        }
      }

      const latex = documents.length === 1 ? documents[0] : combineDocuments(documents);
      const { pdf: buffer } = await pdf.compile(latex, { jobName: slugify(set.title) });
      const base = documents.length === 1
        ? filenameFor(set, kindList[0], versionList[0], set.versions).replace(/\.tex$/, '')
        : `${slugify(set.title)}-all`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${base}.pdf"`);
      res.send(buffer);
    } catch (error) {
      if (error.code === 'ENOENGINE') {
        res.status(501).json({
          error: 'No LaTeX engine is installed on this machine. Download the .tex file, '
            + 'or install TeX Live / MacTeX to enable one-click PDFs.',
        });
        return;
      }
      if (error.code === 'EBUILD') {
        res.status(422).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  return router;
}

module.exports = { createRouter, createDocumentRouter, parseVersion, adHocSet, DOCUMENT_KINDS };
