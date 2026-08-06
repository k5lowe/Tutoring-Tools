'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseQuestions } = require('../server/lib/quickparse');
const { instantiate } = require('../server/lib/variants');

test('a plain question, with no escaping anywhere', () => {
  const { questions, errors } = parseQuestions(`
@ Algebra 1 > Factoring > Monic trinomials | d2 | tags: factoring, drill

Q: Factor completely: $x^2 - 5x - 14$
A: $(x-7)(x+2)$
S: Two numbers with product $-14$ and sum $-5$: $-7$ and $2$.
`);
  assert.deepEqual(errors, []);
  assert.equal(questions.length, 1);
  const [q] = questions;
  assert.equal(q.subject, 'Algebra 1');
  assert.equal(q.topic, 'Factoring');
  assert.equal(q.subtopic, 'Monic trinomials');
  assert.equal(q.difficulty, 2);
  assert.deepEqual(q.tags, ['factoring', 'drill']);
  assert.equal(q.kind, 'static');
  assert.equal(q.statement, 'Factor completely: $x^2 - 5x - 14$');
  assert.equal(q.answer, '$(x-7)(x+2)$');
  assert.match(q.solution, /product \$-14\$/);
});

test('backslashes are literal — the whole point of not using JSON', () => {
  const { questions, errors } = parseQuestions(String.raw`
Q: Simplify $\frac{1}{2} + \frac{1}{3}$ and give $\sqrt[3]{8}$.
A: $\frac{5}{6}$ and $2$
`);
  assert.deepEqual(errors, []);
  assert.equal(questions[0].statement,
    'Simplify $\\frac{1}{2} + \\frac{1}{3}$ and give $\\sqrt[3]{8}$.');
  assert.equal(questions[0].answer, '$\\frac{5}{6}$ and $2$');
});

test('context carries down and can be changed part-way', () => {
  const { questions, errors } = parseQuestions(`
@ Geometry > Circles | d1
Q: First
A: 1
---
Q: Second
A: 2
---
@ Calculus 1 > Derivatives | d4 | tags: chain-rule
Q: Third
A: 3
`);
  assert.deepEqual(errors, []);
  assert.equal(questions.length, 3);
  assert.deepEqual(questions.map((q) => q.subject),
    ['Geometry', 'Geometry', 'Calculus 1']);
  assert.deepEqual(questions.map((q) => q.difficulty), [1, 1, 4]);
  assert.deepEqual(questions[2].tags, ['chain-rule']);
  assert.deepEqual(questions[0].tags, [], 'tags are not inherited from nowhere');
});

test('a context line can change one setting and keep the rest', () => {
  const { questions } = parseQuestions(`
@ Algebra 2 > Quadratics | d2 | book: Course Packet | section: 4.6
Q: Easy one
---
@ | d5
Q: Hard one
`);
  assert.equal(questions[1].subject, 'Algebra 2', 'path is kept');
  assert.equal(questions[1].source_section, '4.6', 'so is the book reference');
  assert.equal(questions[1].difficulty, 5, 'but the difficulty changed');
});

test('a new Q: ends the previous question without needing a separator', () => {
  const { questions, errors } = parseQuestions(`
Q: One
A: 1
Q: Two
A: 2
Q: Three
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(questions.map((q) => q.statement), ['One', 'Two', 'Three']);
  assert.equal(questions[2].answer, '', 'an answer is optional');
});

test('fields run over multiple lines, blank lines included', () => {
  const { questions, errors } = parseQuestions(`
Q: A train leaves at 9:00.

A second train leaves at 11:00.

When does it catch up?
A: 3:00 pm
`);
  assert.deepEqual(errors, []);
  assert.equal(questions.length, 1);
  assert.match(questions[0].statement, /^A train leaves at 9:00\./);
  assert.match(questions[0].statement, /When does it catch up\?$/);
  assert.ok(questions[0].statement.includes('\n\n'), 'paragraph breaks survive');
});

test('V: lines build a generated question that actually generates', () => {
  const { questions, errors } = parseQuestions(`
@ Algebra 1 > Linear Equations | d2
Q: Solve for $x$: $ {{coef(a,'x')}} {{signed(b)}} = {{c}} $
A: $x = {{x}}$
V: a = int 2..9
V: x = int -9..9 except 0
V: b = int -12..12 except 0
V: c = expr a*x + b
C: a != 1
`);
  assert.deepEqual(errors, []);
  const [q] = questions;
  assert.equal(q.kind, 'template', 'variables make it generated');
  assert.deepEqual(q.params.vars.a, { type: 'int', min: 2, max: 9 });
  assert.deepEqual(q.params.vars.x, { type: 'int', min: -9, max: 9, exclude: [0] });
  assert.deepEqual(q.params.vars.c, { type: 'expr', expr: 'a*x + b' });
  assert.deepEqual(q.params.constraints, ['a != 1']);

  // And the numbers it draws are self-consistent.
  for (let seed = 1; seed <= 50; seed += 1) {
    const { vars } = instantiate(q, seed);
    assert.equal(vars.a * vars.x + vars.b, vars.c, `seed ${seed}`);
    assert.notEqual(vars.a, 1);
  }
});

test('every variable type', () => {
  const { questions, errors } = parseQuestions(`
Q: {{n}} {{d}} {{shape}} {{word}} {{total}}
V: n = int 1..10 except 5, 6 step 2
V: d = decimal 0.5..4 step 0.5
V: shape = choice 3, 4, 5
V: word = choice "square", 'hexagon'
V: total = expr n + 1
`);
  assert.deepEqual(errors, []);
  const { vars } = questions[0].params;
  assert.deepEqual(vars.n, { type: 'int', min: 1, max: 10, exclude: [5, 6], step: 2 });
  assert.deepEqual(vars.d, { type: 'decimal', min: 0.5, max: 4, step: 0.5 });
  assert.deepEqual(vars.shape, { type: 'choice', values: [3, 4, 5] });
  assert.deepEqual(vars.word, { type: 'choice', values: ['square', 'hexagon'] },
    'quotes are stripped and non-numeric stays a string');
});

test('per-question overrides', () => {
  const { questions } = parseQuestions(`
@ Algebra 1 > Factoring | d2
Q: Standard
---
Q: A harder one
D: 5
N: 17
K: my-stable-key
`);
  assert.equal(questions[0].difficulty, 2);
  assert.equal(questions[1].difficulty, 5);
  assert.equal(questions[1].source_number, '17');
  assert.equal(questions[1].external_key, 'my-stable-key');
  assert.equal(questions[0].external_key, undefined, 'only where asked for');
});

test('mistakes are reported with a line number, and do not sink the batch', () => {
  const { questions, errors } = parseQuestions(`
Q: Fine one
A: yes
---
A: an answer with no question
---
Q: Missing its range
V: a = int
---
Q: Unknown type
V: b = colour red
---
Q:
A: no question text
---
Q: Also fine
A: yes
`);
  assert.equal(questions.length, 2, 'the good ones still come through');
  assert.deepEqual(questions.map((q) => q.statement), ['Fine one', 'Also fine']);

  const messages = errors.map((error) => `${error.line}: ${error.message}`).join('\n');
  assert.match(messages, /5: "A:" appears before any "Q:"/);
  assert.match(messages, /needs a range like 2\.\.9/);
  assert.match(messages, /unknown type "colour"/);
  assert.match(messages, /no text after "Q:"/);
  assert.ok(errors.every((error) => Number.isInteger(error.line) && error.line > 0));
});

test('a generated question that cannot generate is caught at import time', () => {
  const { questions, errors } = parseQuestions(`
Q: Impossible: {{a}}
V: a = int 1..3
C: a > 100
`);
  assert.equal(questions.length, 0, 'it is not silently accepted');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /cannot generate/);
});

test('a placeholder naming a variable that was never declared is caught', () => {
  const { questions, errors } = parseQuestions(`
Q: Compute {{a}} times {{b}}
A: {{a*b}}
V: a = int 2..9
`);
  assert.equal(questions.length, 0);
  assert.match(errors[0].message, /cannot generate.*b/s);
});

test('empty and comment-only input is not an error', () => {
  assert.deepEqual(parseQuestions(''), { questions: [], errors: [] });
  assert.deepEqual(parseQuestions('\n\n   \n'), { questions: [], errors: [] });
  assert.deepEqual(parseQuestions('@ Algebra 1 > Factoring'), { questions: [], errors: [] });
});

test('a realistic batch parses in one go', () => {
  const { questions, errors } = parseQuestions(String.raw`
@ Algebra 2 > Quadratics | d3 | tags: quadratics | book: Course Packet | section: 4.6

Q: Solve using the quadratic formula: $2x^2 - 3x - 8 = 0$
A: $x = \dfrac{3 \pm \sqrt{73}}{4}$
N: 12
---
Q: Solve for $x$: $ {{coef(a,'x^2')}} {{signed(c)}} = 0 $
A: $x = \pm{{radical(-c)}}$ (when $-c/a > 0$)
V: a = int 1..1
V: c = int -25..-1
---
@ | d5 | tags: quadratics, challenge
Q: For which values of $k$ does $x^2 + kx + 9 = 0$ have exactly one solution?
A: $k = \pm 6$
`);
  assert.deepEqual(errors, []);
  assert.equal(questions.length, 3);
  assert.deepEqual(questions.map((q) => q.kind), ['static', 'template', 'static']);
  assert.equal(questions[0].source_number, '12');
  assert.equal(questions[1].source_section, '4.6', 'context still applies');
  assert.deepEqual(questions[2].tags, ['quadratics', 'challenge']);
  assert.equal(questions[2].difficulty, 5);
});
