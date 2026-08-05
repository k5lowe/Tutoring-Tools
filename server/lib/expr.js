'use strict';

/**
 * A small, safe expression language used by parameterised ("template")
 * problems. It is deliberately *not* JavaScript: there is no property access,
 * no assignment, and no way to reach a host object. Values are numbers or
 * strings; strings only ever come out of the formatting helpers below.
 *
 *   evaluate('a*b + 1', { a: 3, b: 4 })      // => 13
 *   evaluate('frac(a, b)', { a: 2, b: 8 })   // => '\\frac{1}{4}'
 */

const MAX_SOURCE = 4000;
const MAX_STEPS = 50000;

class ExprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExprError';
  }
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

// Longest-first so that '<=' wins over '<'.
const PUNCT = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '(', ')', ',', '<', '>', '!'];

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => /[A-Za-z_]/.test(c);
const isIdentPart = (c) => /[A-Za-z0-9_]/.test(c);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let buf = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          buf += src[j + 1];
          j += 2;
          continue;
        }
        buf += src[j];
        j += 1;
      }
      if (j >= src.length) throw new ExprError('unterminated string literal');
      tokens.push({ type: 'str', value: buf });
      i = j + 1;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j += 1;
      if (src[j] === '.') {
        j += 1;
        while (j < src.length && isDigit(src[j])) j += 1;
      }
      const text = src.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new ExprError(`bad number: ${text}`);
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j += 1;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (!punct) throw new ExprError(`unexpected character ${JSON.stringify(c)}`);
    tokens.push({ type: 'punct', value: punct });
    i += punct.length;
  }
  tokens.push({ type: 'end', value: null });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent -> AST)
// ---------------------------------------------------------------------------

function parse(src) {
  if (typeof src !== 'string') throw new ExprError('expression must be a string');
  if (src.length > MAX_SOURCE) throw new ExprError('expression too long');
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const atPunct = (...values) => {
    const t = tokens[pos];
    return t.type === 'punct' && values.includes(t.value);
  };
  const eatPunct = (value) => {
    if (!atPunct(value)) throw new ExprError(`expected ${JSON.stringify(value)}`);
    pos += 1;
  };

  function parseOr() {
    let node = parseAnd();
    while (atPunct('||')) {
      pos += 1;
      node = { kind: 'logical', op: '||', left: node, right: parseAnd() };
    }
    return node;
  }

  function parseAnd() {
    let node = parseComparison();
    while (atPunct('&&')) {
      pos += 1;
      node = { kind: 'logical', op: '&&', left: node, right: parseComparison() };
    }
    return node;
  }

  function parseComparison() {
    let node = parseAdditive();
    while (atPunct('==', '!=', '<', '<=', '>', '>=')) {
      const op = peek().value;
      pos += 1;
      node = { kind: 'compare', op, left: node, right: parseAdditive() };
    }
    return node;
  }

  function parseAdditive() {
    let node = parseMultiplicative();
    while (atPunct('+', '-')) {
      const op = peek().value;
      pos += 1;
      node = { kind: 'binary', op, left: node, right: parseMultiplicative() };
    }
    return node;
  }

  function parseMultiplicative() {
    let node = parseUnary();
    while (atPunct('*', '/', '%')) {
      const op = peek().value;
      pos += 1;
      node = { kind: 'binary', op, left: node, right: parseUnary() };
    }
    return node;
  }

  function parseUnary() {
    if (atPunct('-', '+', '!')) {
      const op = peek().value;
      pos += 1;
      return { kind: 'unary', op, operand: parseUnary() };
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (atPunct('^')) {
      pos += 1;
      // Right-associative, and the exponent may be unary: 2^-1.
      return { kind: 'binary', op: '^', left: base, right: parseUnary() };
    }
    return base;
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === 'num' || t.type === 'str') {
      pos += 1;
      return { kind: 'literal', value: t.value };
    }
    if (t.type === 'ident') {
      pos += 1;
      if (atPunct('(')) {
        pos += 1;
        const args = [];
        if (!atPunct(')')) {
          args.push(parseOr());
          while (atPunct(',')) {
            pos += 1;
            args.push(parseOr());
          }
        }
        eatPunct(')');
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'variable', name: t.value };
    }
    if (atPunct('(')) {
      pos += 1;
      const inner = parseOr();
      eatPunct(')');
      return inner;
    }
    throw new ExprError(`unexpected ${t.type === 'end' ? 'end of expression' : JSON.stringify(t.value)}`);
  }

  const ast = parseOr();
  if (peek().type !== 'end') throw new ExprError(`unexpected trailing ${JSON.stringify(peek().value)}`);
  return ast;
}

// ---------------------------------------------------------------------------
// Numeric / LaTeX helpers exposed to expressions
// ---------------------------------------------------------------------------

function asNumber(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExprError(`${where} expects a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Trim floating-point noise so 0.30000000000000004 prints as 0.3. */
function tidy(n) {
  if (Number.isInteger(n)) return n;
  const rounded = Number(n.toFixed(9));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatNumber(n) {
  return String(tidy(asNumber(n, 'number formatting')));
}

/** Render a value for substitution into LaTeX. */
function formatValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return formatNumber(value);
}

function latexFraction(numerator, denominator) {
  let n = Math.round(asNumber(numerator, 'frac'));
  let d = Math.round(asNumber(denominator, 'frac'));
  if (d === 0) throw new ExprError('frac: denominator is zero');
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1;
  n /= g;
  d /= g;
  if (d === 1) return String(n);
  return n < 0 ? `-\\frac{${-n}}{${d}}` : `\\frac{${n}}{${d}}`;
}

/** 12 -> '2\\sqrt{3}', 9 -> '3', 3 -> '\\sqrt{3}'. */
function simplifiedRadical(value) {
  const n = Math.round(asNumber(value, 'radical'));
  if (n === 0) return '0';
  const magnitude = Math.abs(n);
  let outside = 1;
  let inside = magnitude;
  for (let f = 2; f * f <= inside; f += 1) {
    while (inside % (f * f) === 0) {
      inside /= f * f;
      outside *= f;
    }
  }
  const imaginary = n < 0 ? 'i' : '';
  if (inside === 1) return imaginary ? `${outside === 1 ? '' : outside}i` : String(outside);
  const radical = `\\sqrt{${inside}}`;
  const lead = outside === 1 ? '' : String(outside);
  return `${lead}${imaginary}${radical}`;
}

/** 3 -> '+ 3', -3 -> '- 3'. For gluing terms together without '+ -4'. */
function signedTerm(value) {
  const n = tidy(asNumber(value, 'signed'));
  return n < 0 ? `- ${Math.abs(n)}` : `+ ${n}`;
}

/** coef(3,'x') -> '3x'; coef(1,'x') -> 'x'; coef(-1,'x') -> '-x'; coef(0,'x') -> '0'. */
function coefficient(value, symbol) {
  const n = tidy(asNumber(value, 'coef'));
  const sym = String(symbol ?? 'x');
  if (n === 0) return '0';
  if (n === 1) return sym;
  if (n === -1) return `-${sym}`;
  return `${n}${sym}`;
}

/** term(3,'x') -> '+ 3x'; term(-1,'x') -> '- x'; term(0,'x') -> ''. */
function signedCoefficient(value, symbol) {
  const n = tidy(asNumber(value, 'term'));
  if (n === 0) return '';
  const body = coefficient(Math.abs(n), symbol);
  return n < 0 ? `- ${body}` : `+ ${body}`;
}

function truthy(value) {
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'boolean') return value;
  return Number.isFinite(value) && value !== 0;
}

const FUNCTIONS = {
  abs: (x) => Math.abs(asNumber(x, 'abs')),
  sqrt: (x) => tidy(Math.sqrt(asNumber(x, 'sqrt'))),
  cbrt: (x) => tidy(Math.cbrt(asNumber(x, 'cbrt'))),
  floor: (x) => Math.floor(asNumber(x, 'floor')),
  ceil: (x) => Math.ceil(asNumber(x, 'ceil')),
  trunc: (x) => Math.trunc(asNumber(x, 'trunc')),
  sign: (x) => Math.sign(asNumber(x, 'sign')),
  round: (x, digits = 0) => {
    const p = 10 ** Math.round(asNumber(digits, 'round'));
    return tidy(Math.round(asNumber(x, 'round') * p) / p);
  },
  min: (...xs) => Math.min(...xs.map((x) => asNumber(x, 'min'))),
  max: (...xs) => Math.max(...xs.map((x) => asNumber(x, 'max'))),
  pow: (x, y) => tidy(asNumber(x, 'pow') ** asNumber(y, 'pow')),
  exp: (x) => tidy(Math.exp(asNumber(x, 'exp'))),
  ln: (x) => tidy(Math.log(asNumber(x, 'ln'))),
  log10: (x) => tidy(Math.log10(asNumber(x, 'log10'))),
  log: (x, base) => tidy(base === undefined
    ? Math.log(asNumber(x, 'log'))
    : Math.log(asNumber(x, 'log')) / Math.log(asNumber(base, 'log'))),
  sin: (x) => tidy(Math.sin(asNumber(x, 'sin'))),
  cos: (x) => tidy(Math.cos(asNumber(x, 'cos'))),
  tan: (x) => tidy(Math.tan(asNumber(x, 'tan'))),
  asin: (x) => tidy(Math.asin(asNumber(x, 'asin'))),
  acos: (x) => tidy(Math.acos(asNumber(x, 'acos'))),
  atan: (x) => tidy(Math.atan(asNumber(x, 'atan'))),
  hypot: (...xs) => tidy(Math.hypot(...xs.map((x) => asNumber(x, 'hypot')))),
  gcd: (...xs) => xs.map((x) => asNumber(x, 'gcd')).reduce((a, b) => gcd(a, b)),
  lcm: (...xs) => xs.map((x) => asNumber(x, 'lcm')).reduce((a, b) => {
    const g = gcd(a, b);
    return g === 0 ? 0 : Math.abs(Math.round(a) * Math.round(b)) / g;
  }),
  fact: (x) => {
    const n = Math.round(asNumber(x, 'fact'));
    if (n < 0 || n > 170) throw new ExprError('fact: out of range');
    let acc = 1;
    for (let k = 2; k <= n; k += 1) acc *= k;
    return acc;
  },
  isint: (x) => (Number.isInteger(tidy(asNumber(x, 'isint'))) ? 1 : 0),
  // Formatting / LaTeX helpers -> strings
  frac: latexFraction,
  radical: simplifiedRadical,
  signed: signedTerm,
  coef: coefficient,
  term: signedCoefficient,
  fmt: (x, digits = 2) => asNumber(x, 'fmt').toFixed(Math.round(asNumber(digits, 'fmt'))),
  str: (x) => formatValue(x),
  cat: (...xs) => xs.map((x) => formatValue(x)).join(''),
  ifelse: (cond, a, b) => (truthy(cond) ? a : b),
};

FUNCTIONS.nCr = (n, r) => {
  const nn = asNumber(n, 'nCr');
  const rr = asNumber(r, 'nCr');
  return tidy(FUNCTIONS.fact(nn) / (FUNCTIONS.fact(rr) * FUNCTIONS.fact(nn - rr)));
};
FUNCTIONS.nPr = (n, r) => {
  const nn = asNumber(n, 'nPr');
  const rr = asNumber(r, 'nPr');
  return tidy(FUNCTIONS.fact(nn) / FUNCTIONS.fact(nn - rr));
};

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function evaluateAst(node, scope, counter) {
  counter.steps += 1;
  if (counter.steps > MAX_STEPS) throw new ExprError('expression too complex');

  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'variable': {
      if (Object.prototype.hasOwnProperty.call(scope, node.name)) return scope[node.name];
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, node.name)) return CONSTANTS[node.name];
      throw new ExprError(`unknown variable ${JSON.stringify(node.name)}`);
    }
    case 'call': {
      const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : null;
      if (!fn) throw new ExprError(`unknown function ${JSON.stringify(node.name)}`);
      const args = node.args.map((arg) => evaluateAst(arg, scope, counter));
      return fn(...args);
    }
    case 'unary': {
      const value = evaluateAst(node.operand, scope, counter);
      if (node.op === '!') return truthy(value) ? 0 : 1;
      const n = asNumber(value, `unary ${node.op}`);
      return node.op === '-' ? -n : n;
    }
    case 'binary': {
      const left = asNumber(evaluateAst(node.left, scope, counter), `operator ${node.op}`);
      const right = asNumber(evaluateAst(node.right, scope, counter), `operator ${node.op}`);
      switch (node.op) {
        case '+': return tidy(left + right);
        case '-': return tidy(left - right);
        case '*': return tidy(left * right);
        case '/':
          if (right === 0) throw new ExprError('division by zero');
          return tidy(left / right);
        case '%':
          if (right === 0) throw new ExprError('modulo by zero');
          return tidy(left % right);
        case '^': {
          const result = left ** right;
          if (!Number.isFinite(result)) throw new ExprError('result is not finite');
          return tidy(result);
        }
        default:
          throw new ExprError(`unsupported operator ${node.op}`);
      }
    }
    case 'compare': {
      const left = evaluateAst(node.left, scope, counter);
      const right = evaluateAst(node.right, scope, counter);
      switch (node.op) {
        case '==': return left === right ? 1 : 0;
        case '!=': return left !== right ? 1 : 0;
        case '<': return left < right ? 1 : 0;
        case '<=': return left <= right ? 1 : 0;
        case '>': return left > right ? 1 : 0;
        case '>=': return left >= right ? 1 : 0;
        default: throw new ExprError(`unsupported comparison ${node.op}`);
      }
    }
    case 'logical': {
      const left = evaluateAst(node.left, scope, counter);
      if (node.op === '&&') {
        return truthy(left) && truthy(evaluateAst(node.right, scope, counter)) ? 1 : 0;
      }
      return truthy(left) || truthy(evaluateAst(node.right, scope, counter)) ? 1 : 0;
    }
    default:
      throw new ExprError(`unsupported node ${node.kind}`);
  }
}

const cache = new Map();

function compile(source) {
  const key = String(source);
  let ast = cache.get(key);
  if (!ast) {
    ast = parse(key);
    if (cache.size > 2000) cache.clear();
    cache.set(key, ast);
  }
  return ast;
}

/** Evaluate `source` against `scope`, returning a number or string. */
function evaluate(source, scope = {}) {
  return evaluateAst(compile(source), scope, { steps: 0 });
}

/** Evaluate and coerce to a boolean, for problem constraints. */
function evaluateCondition(source, scope = {}) {
  return truthy(evaluate(source, scope));
}

module.exports = {
  ExprError,
  evaluate,
  evaluateCondition,
  formatValue,
  formatNumber,
  truthy,
  tidy,
  gcd,
  helpers: Object.keys(FUNCTIONS).sort(),
};
