'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { instantiate, substitute, VariantError } = require('../server/lib/variants');
const { computeLabels, groupBySection } = require('../server/lib/numbering');
const { render } = require('../server/lib/mustache');
const { combineDocuments, versionSeed, escapeMetadata } = require('../server/lib/latex');
const { selectProblems } = require('../server/lib/select');

const LINEAR = {
  kind: 'template',
  statement: "Solve: $ {{coef(a,'x')}} {{signed(b)}} = {{c}} $",
  answer: '$x = {{x}}$',
  solution: '',
  params: {
    vars: {
      a: { type: 'int', min: 2, max: 9 },
      x: { type: 'int', min: -9, max: 9, exclude: [0] },
      b: { type: 'int', min: -12, max: 12, exclude: [0] },
      c: { type: 'expr', expr: 'a*x + b' },
    },
  },
};

test('the same seed always produces the same problem', () => {
  const first = instantiate(LINEAR, 4242);
  const second = instantiate(LINEAR, 4242);
  assert.deepEqual(first, second);
  assert.notEqual(instantiate(LINEAR, 4243).statement, first.statement);
});

test('generated problems are internally consistent', () => {
  // The whole point of computed parameters: the answer must actually solve the
  // equation that was printed.
  for (let seed = 1; seed <= 300; seed += 1) {
    const { vars } = instantiate(LINEAR, seed);
    assert.equal(vars.a * vars.x + vars.b, vars.c, `seed ${seed}`);
    assert.notEqual(vars.x, 0, `seed ${seed} honours exclude`);
    assert.notEqual(vars.b, 0, `seed ${seed} honours exclude`);
    assert.ok(vars.a >= 2 && vars.a <= 9, `seed ${seed} respects the range`);
  }
});

test('static problems pass through untouched', () => {
  const problem = { kind: 'static', statement: 'Prove that $\\{{a\\}}$ is odd.', answer: 'QED', solution: '' };
  const instance = instantiate(problem, 99);
  assert.equal(instance.statement, problem.statement);
  assert.deepEqual(instance.vars, {});
});

test('constraints are enforced', () => {
  const problem = {
    kind: 'template',
    statement: '{{a}} and {{b}}',
    params: { vars: { a: { type: 'int', min: 1, max: 6 }, b: { type: 'int', min: 1, max: 6 } }, constraints: ['a > b'] },
  };
  for (let seed = 1; seed <= 100; seed += 1) {
    const { vars } = instantiate(problem, seed);
    assert.ok(vars.a > vars.b, `seed ${seed}`);
  }
});

test('impossible constraints fail loudly rather than looping forever', () => {
  const problem = {
    kind: 'template',
    statement: '{{a}}',
    params: { vars: { a: { type: 'int', min: 1, max: 3 } }, constraints: ['a > 100'] },
  };
  assert.throws(() => instantiate(problem, 1), VariantError);
});

test('choice parameters can hold strings', () => {
  const problem = {
    kind: 'template',
    statement: 'A {{shape}} with side {{s}}.',
    params: { vars: { shape: { type: 'choice', values: ['square', 'hexagon'] }, s: { type: 'int', min: 2, max: 5 } } },
  };
  const instance = instantiate(problem, 7);
  assert.ok(['square', 'hexagon'].some((shape) => instance.statement.includes(shape)));
});

test('placeholders survive nesting inside LaTeX groups', () => {
  assert.equal(substitute('\\frac{{{a}}}{2}', { a: 7 }), '\\frac{7}{2}');
  assert.equal(substitute('x^{ {{n}} }', { n: 3 }), 'x^{ 3 }');
  assert.equal(substitute('no placeholders', {}), 'no placeholders');
});

test('a bad placeholder names the offending expression', () => {
  assert.throws(
    () => substitute('{{nope + 1}}', { a: 1 }),
    (error) => error instanceof VariantError && error.message.includes('{{nope + 1}}'),
  );
});

test('numbering: sequential, textbook and grouped modes', () => {
  const items = [
    { source_section: '3.4', source_number: '17', topic: 'Factoring', source_book: 'Book' },
    { source_section: '3.4', source_number: '19', topic: 'Factoring', source_book: 'Book' },
    { source_section: '4.1', source_number: '', topic: 'Quadratics', source_book: 'Book' },
  ];

  assert.deepEqual(
    computeLabels(items, 'sequential').map((entry) => entry.label),
    ['1.', '2.', '3.'],
  );

  assert.deepEqual(
    computeLabels(items, 'textbook').map((entry) => entry.label),
    ['3.4\\,\\#17.', '3.4\\,\\#19.', '3.'],
    'a problem with no book number falls back to the running count',
  );

  const grouped = computeLabels(items, 'section');
  assert.deepEqual(grouped.map((entry) => entry.label), ['\\#17.', '\\#19.', '1.']);
  assert.ok(grouped[0].heading.includes('3.4'));
  assert.equal(grouped[1].heading, null, 'a heading appears only when the section changes');
  assert.ok(grouped[2].heading.includes('4.1'));
});

test('grouping gathers sections without disturbing order inside one', () => {
  const items = [
    { source_section: '3.4', source_number: '1' },
    { source_section: '7.1', source_number: '2' },
    { source_section: '3.4', source_number: '3' },
    { source_section: '', source_number: '4' },
    { source_section: '7.1', source_number: '5' },
  ];
  assert.deepEqual(
    groupBySection(items).map((item) => item.source_number),
    ['1', '3', '2', '5', '4'],
    'sections appear in first-seen order; unsectioned problems land last',
  );

  // The point of grouping: each heading is emitted exactly once.
  const grouped = computeLabels(groupBySection(items), 'section');
  const headings = grouped.filter((entry) => entry.heading).length;
  assert.equal(headings, 3, 'one heading per distinct section');
  assert.equal(
    computeLabels(items, 'section').filter((entry) => entry.heading).length,
    5,
    'ungrouped input would repeat headings, which is what grouping avoids',
  );
});

test('numbering: explicit label overrides win', () => {
  const labels = computeLabels([{ label_override: 'Warm-up' }, {}], 'sequential');
  assert.equal(labels[0].label, 'Warm-up');
  assert.equal(labels[1].label, '2.');
});

test('mustache: sections, inverted sections and loops', () => {
  assert.equal(render('{{a}}-{{b}}', { a: 1, b: 2 }), '1-2');
  assert.equal(render('{{#on}}yes{{/on}}{{^on}}no{{/on}}', { on: true }), 'yes');
  assert.equal(render('{{#on}}yes{{/on}}{{^on}}no{{/on}}', { on: '' }), 'no');
  assert.equal(render('{{#xs}}[{{v}}]{{/xs}}', { xs: [{ v: 1 }, { v: 2 }] }), '[1][2]');
  assert.equal(render('{{#xs}}{{outer}}{{/xs}}', { outer: 'A', xs: [{}] }), 'A', 'parent scope stays visible');
  assert.equal(render('{{! ignored }}kept', {}), 'kept');
  assert.throws(() => render('{{#a}}unclosed', {}));
  assert.throws(() => render('{{#a}}x{{/b}}', {}));
});

test('metadata escaping protects a build without breaking math', () => {
  assert.equal(escapeMetadata('Ch 3 & 4'), 'Ch 3 \\& 4');
  assert.equal(escapeMetadata('50% off'), '50\\% off');
  assert.equal(escapeMetadata('$x^2$ review'), '$x^2$ review', 'inline math is left alone');
  assert.equal(escapeMetadata('already \\& escaped'), 'already \\& escaped', 'no double escaping');
});

test('versions derive distinct but reproducible seeds', () => {
  assert.equal(versionSeed(500, 0), 500, 'version A is the stored seed');
  const b = versionSeed(500, 1);
  const c = versionSeed(500, 2);
  assert.notEqual(b, 500);
  assert.notEqual(b, c);
  assert.equal(versionSeed(500, 1), b, 'and are stable across calls');
});

test('combining documents keeps one preamble and gathers packages', () => {
  const practice = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nA\n\\end{document}\n';
  const answers = '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{multicol}\n'
    + '\\begin{document}\nB\n\\end{document}\n';
  const combined = combineDocuments([practice, answers]);

  assert.equal((combined.match(/documentclass/g) || []).length, 1);
  assert.equal((combined.match(/\\begin\{document\}/g) || []).length, 1);
  assert.equal((combined.match(/usepackage\{multicol\}/g) || []).length, 1, 'multicol is carried over');
  assert.equal((combined.match(/usepackage\{amsmath\}/g) || []).length, 1, 'and amsmath is not duplicated');
  assert.ok(combined.includes('\\newpage'));
  assert.ok(combined.indexOf('A') < combined.indexOf('B'));
});

test('combining carries macro definitions across, without redefining them', () => {
  // A bundle used to take only the first preamble plus \usepackage lines, which
  // silently dropped macros the later templates define — the merged file then
  // failed to build on an undefined control sequence.
  const shared = '\\newcommand{\\problem}[2]{#1 #2}';
  const practice = `\\documentclass{article}\n\n${shared}\n\n\\begin{document}\nA\n\\end{document}\n`;
  const notes = `\\documentclass{article}\n\n${shared}\n\n`
    + '\\newcommand{\\solutionlabel}{\\textit{Solution.}}\n\n'
    + '\\begin{document}\nB \\solutionlabel\n\\end{document}\n';
  const combined = combineDocuments([practice, notes]);

  assert.equal((combined.match(/\\newcommand\{\\solutionlabel\}/g) || []).length, 1,
    'the macro the later document needs is present');
  assert.equal((combined.match(/\\newcommand\{\\problem\}/g) || []).length, 1,
    'the shared macro is defined exactly once');
  assert.ok(combined.indexOf('\\newcommand{\\solutionlabel}') < combined.indexOf('\\begin{document}'),
    'and it lands in the preamble');
});

test('combining tolerates a reformatted duplicate definition', () => {
  const a = '\\documentclass{article}\n\n\\newcommand{\\problem}[2]{#1 #2}\n\n\\begin{document}\nA\n\\end{document}\n';
  const b = '\\documentclass{article}\n\n\\newcommand{\\problem}[2]{%\n  #1 #2\n}\n\n\\begin{document}\nB\n\\end{document}\n';
  const combined = combineDocuments([a, b]);
  assert.equal((combined.match(/\\newcommand\{\\problem\}/g) || []).length, 1,
    'a second definition of the same macro is skipped even when written differently');
});

test('selection honours count, order and the template top-up', () => {
  const pool = Array.from({ length: 20 }, (unused, index) => ({
    id: index + 1, difficulty: (index % 5) + 1, kind: 'static',
  }));

  const { problems } = selectProblems(pool, { count: 8, distribution: 'ramp', seed: 3 });
  assert.equal(problems.length, 8);
  const levels = problems.map((problem) => problem.difficulty);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'ramp is ascending');

  const mixed = selectProblems(pool, { count: 5, distribution: 'mixed', seed: 3 });
  assert.equal(new Set(mixed.problems.map((problem) => problem.difficulty)).size, 5,
    'mixed spreads across difficulty levels');

  const small = [{ id: 1, difficulty: 3, kind: 'template' }];
  assert.equal(selectProblems(small, { count: 4, seed: 1 }).problems.length, 4,
    'templates are reused to reach the requested count');
  assert.equal(selectProblems([{ id: 1, difficulty: 3, kind: 'static' }], { count: 4, seed: 1 }).shortfall, 3,
    'fixed problems are never duplicated; the shortfall is reported');
});
