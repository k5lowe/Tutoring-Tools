'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { instantiate, substitute, VariantError } = require('../server/lib/variants');

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
