'use strict';

const { render } = require('./mustache');
const { computeLabels, textbookReference, groupBySection } = require('./numbering');
const { instantiate } = require('./variants');

/**
 * Turns a saved set plus a document template into LaTeX source.
 *
 * Three document kinds share one pipeline, differing only in the template that
 * is applied: `practice` (problems and working space), `notes` (worked
 * examples for a standalone lesson handout) and `answers` (a compact key).
 */

/**
 * Short metadata fields are typed into form inputs, so the characters that
 * would break a build get escaped. Backslashes, braces and `$` are left alone
 * so `Ch.~3 $x^2$` still works — statements and instructions are authored as
 * LaTeX and are never escaped.
 */
function escapeMetadata(value) {
  return String(value ?? '').replace(/(?<!\\)[&%#_]/g, (c) => `\\${c}`);
}

/** Mix a base seed with a version index so version B looks nothing like A. */
function versionSeed(seed, versionIndex) {
  const base = (Number(seed) >>> 0) || 1;
  if (!versionIndex) return base;
  let h = (base ^ Math.imul(versionIndex + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) || 1;
}

const VERSION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function versionLabel(index) {
  return VERSION_LETTERS[index % 26] + (index >= 26 ? String(Math.floor(index / 26) + 1) : '');
}

/**
 * Resolve every item in a set into concrete statement/answer/solution text.
 * Per-item overrides win over the generated text, so a tutor can hand-tweak
 * one problem in a set without editing the bank entry.
 */
function resolveItems(items, { versionIndex = 0 } = {}) {
  return items.map((item) => {
    const seed = versionSeed(item.seed, versionIndex);
    let generated;
    let error = null;
    try {
      generated = instantiate(item, seed);
    } catch (cause) {
      error = cause.message;
      generated = {
        statement: item.statement || '',
        answer: item.answer || '',
        solution: item.solution || '',
        vars: {},
      };
    }
    return {
      ...item,
      seed,
      error,
      statement: item.override_statement || generated.statement,
      answer: item.override_answer || generated.answer,
      solution: item.override_solution || generated.solution,
      vars: generated.vars,
    };
  });
}

function buildContext(set, items, { kind = 'practice', versionIndex = 0, versions = 1 } = {}) {
  const meta = set.meta && typeof set.meta === 'object' ? set.meta : {};
  const resolved = set.numbering === 'section' ? groupBySection(items) : items;
  const labels = computeLabels(resolved, set.numbering, { startAt: set.start_at || 1 });
  const objectives = Array.isArray(meta.objectives)
    ? meta.objectives.filter(Boolean).map((text) => ({ text: String(text) }))
    : [];

  const problems = resolved.map((item, index) => {
    const reference = textbookReference(item, { showSection: true });
    return {
      n: index + 1,
      label: labels[index].label,
      heading: labels[index].heading || '',
      statement: item.statement,
      answer: item.answer,
      solution: item.solution,
      hasAnswer: Boolean(item.answer && item.answer.trim()),
      hasSolution: Boolean(item.solution && item.solution.trim()),
      source: reference,
      sourceBook: escapeMetadata(item.source_book || ''),
      difficulty: item.difficulty,
      subject: escapeMetadata(item.subject || ''),
      topic: escapeMetadata(item.topic || ''),
      subtopic: escapeMetadata(item.subtopic || ''),
      workspace: item.workspace || meta.workspace || '',
    };
  });

  return {
    kind,
    isPractice: kind === 'practice',
    isNotes: kind === 'notes',
    isAnswers: kind === 'answers',
    title: escapeMetadata(set.title || 'Practice Set'),
    course: escapeMetadata(meta.course || set.subject || ''),
    student: escapeMetadata(meta.student || ''),
    date: escapeMetadata(meta.date || ''),
    instructions: meta.instructions || '',
    objectives,
    hasObjectives: objectives.length > 0,
    notes: meta.notes || '',
    itemsep: meta.itemsep || (kind === 'practice' ? '2.5em' : '0.75em'),
    columns: Number(meta.columns) > 1 ? Math.floor(Number(meta.columns)) : 1,
    multipleColumns: Number(meta.columns) > 1,
    version: versions > 1 ? versionLabel(versionIndex) : '',
    hasVersions: versions > 1,
    count: problems.length,
    problems,
    anyAnswers: problems.some((p) => p.hasAnswer),
    anySolutions: problems.some((p) => p.hasSolution),
  };
}

/** Render a set to LaTeX using `templateBody`. */
function buildDocument({ set, items, templateBody, kind = 'practice', versionIndex = 0, versions = 1 }) {
  const resolved = resolveItems(items, { versionIndex });
  const context = buildContext(set, resolved, { kind, versionIndex, versions });
  const latex = render(templateBody, context);
  return {
    latex,
    context,
    warnings: resolved.filter((item) => item.error).map((item) => ({ problemId: item.problem_id, message: item.error })),
  };
}

const BEGIN_DOC = '\\begin{document}';
const END_DOC = '\\end{document}';

const PACKAGE_LINE = /^[ \t]*\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}[ \t]*$/;

/**
 * Names a preamble block defines, so the same macro is never defined twice when
 * preambles are merged (LaTeX treats a repeat \newcommand as a hard error).
 */
function definedNames(block) {
  const names = [];
  for (const match of block.matchAll(/\\(?:new|renew|provide)command\s*\*?\s*\{?\s*\\([A-Za-z@]+)/g)) {
    names.push(`cmd:${match[1]}`);
  }
  for (const match of block.matchAll(/\\def\s*\\([A-Za-z@]+)/g)) names.push(`cmd:${match[1]}`);
  for (const match of block.matchAll(/\\new(?:length|counter|toks|savebox)\s*\{?\s*\\?([A-Za-z@]+)/g)) {
    names.push(`reg:${match[1]}`);
  }
  for (const match of block.matchAll(/\\new(?:environment|theorem)\s*\*?\s*\{([^}]+)\}/g)) {
    names.push(`env:${match[1]}`);
  }
  return names;
}

/**
 * Merge several rendered documents into one file, separated by page breaks —
 * for printing all versions and their keys in a single pass.
 *
 * The templates for the different document kinds have overlapping but not
 * identical preambles (the key loads multicol; the notes template defines its
 * own macros), so a single preamble is rebuilt from all of them:
 *   - one \documentclass, from the first document
 *   - the union of \usepackage lines, each package loaded once
 *   - every other preamble block once, skipping any block that would redefine
 *     a macro an earlier block already defined
 */
function combineDocuments(documents) {
  const usable = documents.filter((source) => source && source.includes(BEGIN_DOC));
  if (usable.length === 0) return '';
  if (usable.length === 1) return usable[0];

  let documentClass = null;
  const packages = new Map();
  const blocks = [];
  const seenBlocks = new Set();
  const seenNames = new Set();
  const bodies = [];

  for (const source of usable) {
    const splitAt = source.indexOf(BEGIN_DOC);
    const endAt = source.lastIndexOf(END_DOC);
    bodies.push(source.slice(splitAt + BEGIN_DOC.length, endAt === -1 ? undefined : endAt).trim());

    for (const rawBlock of source.slice(0, splitAt).split(/\n[ \t]*\n/)) {
      const kept = [];
      for (const line of rawBlock.split('\n')) {
        if (/^[ \t]*\\documentclass/.test(line)) {
          if (!documentClass) documentClass = line.trim();
          continue;
        }
        const packageMatch = PACKAGE_LINE.exec(line);
        if (packageMatch) {
          const names = packageMatch[1].split(',').map((name) => name.trim()).filter(Boolean);
          // Keep the line unless every package on it is already loaded.
          if (names.some((name) => !packages.has(name))) {
            for (const name of names) packages.set(name, line.trim());
          }
          continue;
        }
        kept.push(line);
      }

      const text = kept.join('\n').trim();
      if (!text || seenBlocks.has(text)) continue;
      const names = definedNames(text);
      if (names.some((name) => seenNames.has(name))) continue;
      seenBlocks.add(text);
      for (const name of names) seenNames.add(name);
      blocks.push(text);
    }
  }

  const packageLines = [...new Set(packages.values())];
  const preamble = [
    documentClass || '\\documentclass[11pt]{article}',
    packageLines.join('\n'),
    blocks.join('\n\n'),
  ].filter(Boolean).join('\n\n');

  return `${preamble}\n\n${BEGIN_DOC}\n\n${bodies.join('\n\n\\newpage\n\n')}\n\n${END_DOC}\n`;
}

function slugify(value, fallback = 'problem-set') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

function filenameFor(set, kind, versionIndex, versions) {
  const suffix = versions > 1 ? `-${versionLabel(versionIndex).toLowerCase()}` : '';
  return `${slugify(set.title)}-${kind}${suffix}.tex`;
}

module.exports = {
  buildDocument,
  combineDocuments,
  resolveItems,
  buildContext,
  escapeMetadata,
  versionSeed,
  versionLabel,
  slugify,
  filenameFor,
};
