'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluate, evaluateCondition, ExprError } = require('../server/lib/expr');

test('arithmetic and precedence', () => {
  assert.equal(evaluate('2 + 3 * 4'), 14);
  assert.equal(evaluate('(2 + 3) * 4'), 20);
  assert.equal(evaluate('2 ^ 3 ^ 2'), 512, 'exponentiation is right-associative');
  assert.equal(evaluate('-2 ^ 2'), -4, 'unary minus binds looser than ^');
  assert.equal(evaluate('2 ^ -1'), 0.5);
  assert.equal(evaluate('7 % 3'), 1);
  assert.equal(evaluate('10 / 4'), 2.5);
});

test('variables and floating-point tidying', () => {
  assert.equal(evaluate('a*x + b', { a: 3, x: -2, b: 7 }), 1);
  assert.equal(evaluate('0.1 + 0.2'), 0.3, 'noise is trimmed so output prints cleanly');
  assert.equal(evaluate('pi > 3.14'), 1);
});

test('comparisons and logic return 1/0', () => {
  assert.equal(evaluate('3 == 3'), 1);
  assert.equal(evaluate('3 != 3'), 0);
  assert.equal(evaluate('2 < 3 && 3 < 4'), 1);
  assert.equal(evaluate('2 > 3 || 3 < 4'), 1);
  assert.equal(evaluate('!0'), 1);
  assert.equal(evaluateCondition('b*b - 4*a*c > 0', { a: 1, b: 5, c: 2 }), true);
  assert.equal(evaluateCondition('b*b - 4*a*c > 0', { a: 1, b: 1, c: 2 }), false);
});

test('frac reduces and moves the sign to the front', () => {
  assert.equal(evaluate('frac(2, 8)'), '\\frac{1}{4}');
  assert.equal(evaluate('frac(6, 3)'), '2', 'an integer result is not a fraction');
  assert.equal(evaluate('frac(-2, 8)'), '-\\frac{1}{4}');
  assert.equal(evaluate('frac(2, -8)'), '-\\frac{1}{4}');
  assert.equal(evaluate('frac(0, 5)'), '0');
  assert.throws(() => evaluate('frac(1, 0)'), ExprError);
});

test('radical extracts the largest square factor', () => {
  assert.equal(evaluate('radical(12)'), '2\\sqrt{3}');
  assert.equal(evaluate('radical(9)'), '3');
  assert.equal(evaluate('radical(3)'), '\\sqrt{3}');
  assert.equal(evaluate('radical(72)'), '6\\sqrt{2}');
  assert.equal(evaluate('radical(1)'), '1');
  assert.equal(evaluate('radical(0)'), '0');
});

test('sign-aware term formatting avoids "+ -3"', () => {
  assert.equal(evaluate('signed(3)'), '+ 3');
  assert.equal(evaluate('signed(-3)'), '- 3');
  assert.equal(evaluate('signed(0)'), '+ 0');
  assert.equal(evaluate("coef(3, 'x')"), '3x');
  assert.equal(evaluate("coef(1, 'x')"), 'x');
  assert.equal(evaluate("coef(-1, 'x')"), '-x');
  assert.equal(evaluate("coef(0, 'x')"), '0');
  assert.equal(evaluate("term(3, 'x')"), '+ 3x');
  assert.equal(evaluate("term(-1, 'x')"), '- x');
  assert.equal(evaluate("term(0, 'x')"), '', 'a zero term disappears entirely');
});

test('number helpers', () => {
  assert.equal(evaluate('gcd(12, 18)'), 6);
  assert.equal(evaluate('lcm(4, 6)'), 12);
  assert.equal(evaluate('fact(5)'), 120);
  assert.equal(evaluate('nCr(5, 2)'), 10);
  assert.equal(evaluate('nPr(5, 2)'), 20);
  assert.equal(evaluate('isint(sqrt(16))'), 1);
  assert.equal(evaluate('isint(sqrt(17))'), 0);
  assert.equal(evaluate('fmt(2/3, 2)'), '0.67');
  assert.equal(evaluate('round(2.345, 2)'), 2.35);
});

test('rejects anything that is not the expression language', () => {
  assert.throws(() => evaluate('process.exit(1)'), ExprError);
  assert.throws(() => evaluate('a = 1'), ExprError);
  assert.throws(() => evaluate('unknownFn(2)'), ExprError);
  assert.throws(() => evaluate('missingVar + 1'), ExprError);
  assert.throws(() => evaluate('1 +'), ExprError);
  assert.throws(() => evaluate('(1 + 2'), ExprError);
  assert.throws(() => evaluate('1 / 0'), ExprError);
  assert.throws(() => evaluate('"unterminated'), ExprError);
});

test('a variable never resolves through the prototype chain', () => {
  assert.throws(() => evaluate('constructor', {}), ExprError);
  assert.throws(() => evaluate('toString', {}), ExprError);
});
