'use strict';

const { fragmentToHtml, escapeHtml } = require('./latex2html');

/**
 * Renders a set to a printable HTML page.
 *
 * This deliberately does not go through the LaTeX template — converting a whole
 * .tex document to HTML would be fragile. Instead it reads the same structured
 * context the LaTeX renderer uses and lays it out with CSS, so the two outputs
 * stay in agreement about content while each plays to its own strengths.
 */

const PRINT_CSS = `
:root { --ink: #111; --muted: #555; --rule: #bbb; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; padding: 2.5rem 3rem 4rem;
  font: 12pt/1.5 "Latin Modern Roman", Georgia, "Times New Roman", serif;
  color: var(--ink); background: #fff; max-width: 8.5in; margin-inline: auto;
}
h1 { font-size: 1.35rem; margin: 0; }
.doc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.version { font-weight: 700; white-space: nowrap; }
.meta { display: flex; justify-content: space-between; gap: 1.5rem; flex-wrap: wrap;
        margin-top: .5rem; color: var(--muted); font-size: .95rem; }
.meta .fill { display: inline-block; min-width: 10rem; border-bottom: 1px solid var(--ink); }
hr { border: 0; border-top: 1.5px solid var(--ink); margin: .75rem 0 1.5rem; }
.instructions { margin-bottom: 1.5rem; }
.objectives-label { margin: 0 0 .4rem; }
.objectives { margin: 0 0 1.5rem 1.2rem; }
.section-heading { font-size: 1.1rem; font-weight: 700; margin: 1.75rem 0 .75rem; }
.problem { display: grid; grid-template-columns: 3.1em 1fr; gap: .35em;
           margin-bottom: var(--itemsep, 2.5em); break-inside: avoid; page-break-inside: avoid; }
.problem-label { font-weight: 700; }
.problem-body > *:first-child { margin-top: 0; }
.problem-body p { margin: .35em 0; }
.solution, .answer-line { margin-top: .5em; }
.solution-label { font-style: italic; }
.source { color: var(--muted); font-size: .8rem; margin-left: .5em; white-space: nowrap; }
.columns { column-count: var(--columns, 3); column-gap: 2.5rem; }
.columns .problem { margin-bottom: .75em; }
.tex-list { margin: .4em 0 .4em 1.2em; padding: 0; }
.tex-list li { margin: .2em 0; }
.vspace { display: block; height: .75em; }
.quad { display: inline-block; width: 1em; }
.qquad { display: inline-block; width: 2em; }
.hfill { display: inline-block; width: 2em; }
.smallcaps { font-variant: small-caps; }
.math-error { color: #b00020; background: #fff0f2; padding: 0 .2em; border-radius: 3px; }
.warnings { border: 1px solid #e0a800; background: #fff8e1; padding: .75rem 1rem;
            border-radius: 6px; margin-bottom: 1.5rem; font-size: .85rem; font-family: ui-sans-serif, sans-serif; }
.toolbar { position: sticky; top: 0; display: flex; gap: .5rem; justify-content: flex-end;
           padding-bottom: 1rem; font-family: ui-sans-serif, system-ui, sans-serif; }
.toolbar button, .toolbar a {
  font: inherit; font-size: .8rem; padding: .4rem .8rem; border: 1px solid var(--rule);
  border-radius: 6px; background: #f6f6f6; color: var(--ink); cursor: pointer; text-decoration: none;
}
.toolbar button:hover, .toolbar a:hover { background: #ececec; }
.workspace { min-height: var(--workspace, 0); }
@media print {
  body { padding: 0; max-width: none; }
  .toolbar, .warnings { display: none !important; }
  @page { margin: 1in; }
}
`;

function metaLine(context) {
  const parts = [];
  if (context.course) parts.push(`<span>${escapeHtml(stripEscapes(context.course))}</span>`);
  const right = [];
  if (context.isPractice) {
    right.push(context.student
      ? `Name: ${escapeHtml(stripEscapes(context.student))}`
      : 'Name: <span class="fill"></span>');
    right.push(context.date
      ? `Date: ${escapeHtml(stripEscapes(context.date))}`
      : 'Date: <span class="fill"></span>');
  } else if (context.date) {
    right.push(escapeHtml(stripEscapes(context.date)));
  }
  if (right.length) parts.push(`<span>${right.join('&nbsp;&nbsp;&nbsp;')}</span>`);
  return parts.length ? `<div class="meta">${parts.join('')}</div>` : '';
}

/** Undo the LaTeX escaping applied to metadata fields before showing as text. */
function stripEscapes(value) {
  return String(value).replace(/\\([&%#_$])/g, '$1');
}

function renderProblem(problem, kind) {
  const pieces = [];
  if (problem.heading) {
    pieces.push(`<div class="section-heading">${fragmentToHtml(problem.heading)}</div>`);
  }

  const body = [];
  if (kind === 'answers') {
    body.push(problem.hasAnswer ? fragmentToHtml(problem.answer) : '&mdash;');
  } else {
    body.push(`<div class="problem-body">${fragmentToHtml(problem.statement)}</div>`);
    if (kind === 'notes' || kind === 'solutions') {
      if (problem.hasSolution) {
        body.push(`<div class="solution"><span class="solution-label">Solution.</span> ${fragmentToHtml(problem.solution)}</div>`);
      } else if (problem.hasAnswer) {
        body.push(`<div class="answer-line"><span class="solution-label">Answer.</span> ${fragmentToHtml(problem.answer)}</div>`);
      }
    }
    if (kind === 'practice' && problem.workspace) {
      body.push(`<div class="workspace" style="--workspace:${escapeHtml(problem.workspace)}"></div>`);
    }
  }

  pieces.push(
    `<div class="problem">`
    + `<div class="problem-label">${fragmentToHtml(problem.label)}</div>`
    + `<div>${body.join('')}</div>`
    + `</div>`,
  );
  return pieces.join('');
}

/**
 * @param {object} context  the context produced by lib/latex.js buildContext
 * @param {object} options  { kind, katexHref, warnings, downloadHref, standalone }
 */
function buildPrintPage(context, options = {}) {
  const kind = options.kind || context.kind || 'practice';
  const katexHref = options.katexHref || '/vendor/katex/katex.min.css';
  const useColumns = kind === 'answers' || context.multipleColumns;
  const columns = kind === 'answers' ? (context.columns > 1 ? context.columns : 3) : context.columns;

  const titleSuffix = kind === 'answers' ? ' — Answer Key' : (kind === 'solutions' ? ' — Worked Solutions' : '');
  const heading = `${stripEscapes(context.title)}${titleSuffix}`;

  const warnings = (options.warnings || []).length
    ? `<div class="warnings"><strong>${options.warnings.length} problem(s) could not be generated</strong><ul>${
      options.warnings.map((w) => `<li>Problem #${escapeHtml(w.problemId)}: ${escapeHtml(w.message)}</li>`).join('')
    }</ul></div>`
    : '';

  const toolbar = options.standalone === false ? '' : `
    <div class="toolbar">
      ${options.downloadHref ? `<a href="${escapeHtml(options.downloadHref)}">Download .tex</a>` : ''}
      <button type="button" onclick="window.print()">Print</button>
    </div>`;

  // An answer key is for the tutor: the student-facing preamble is dropped,
  // matching what the answers template emits.
  const showPreamble = kind !== 'answers';
  const objectives = showPreamble && context.hasObjectives
    ? `<p class="objectives-label"><strong>Objectives</strong></p>`
      + `<ul class="objectives">${context.objectives.map((o) => `<li>${fragmentToHtml(o.text)}</li>`).join('')}</ul>`
    : '';

  const problems = context.problems.map((problem) => renderProblem(problem, kind)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<!-- Declared so the browser doesn't request a /favicon.ico that isn't there. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E%3Ctext%20y='.9em'%20font-size='90'%3E%F0%9F%93%90%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="${escapeHtml(katexHref)}">
<style>${PRINT_CSS}</style>
</head>
<body style="--itemsep:${escapeHtml(context.itemsep || '2.5em')}">
${toolbar}
${warnings}
<div class="doc-head">
  <h1>${escapeHtml(heading)}</h1>
  ${context.hasVersions ? `<div class="version">Version ${escapeHtml(context.version)}</div>` : ''}
</div>
${metaLine(context)}
<hr>
${objectives}
${showPreamble && context.instructions ? `<div class="instructions">${fragmentToHtml(context.instructions)}</div>` : ''}
${useColumns ? `<div class="columns" style="--columns:${columns}">` : ''}
${problems}
${useColumns ? '</div>' : ''}
${context.notes ? `<hr><div class="instructions">${fragmentToHtml(context.notes)}</div>` : ''}
</body>
</html>`;
}

module.exports = { buildPrintPage, PRINT_CSS };
