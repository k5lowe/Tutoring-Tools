'use strict';

const { makeRng } = require('./rng');
const { evaluate, evaluateCondition, formatValue, ExprError } = require('./expr');

/**
 * Parameterised problems ("templates").
 *
 * A template problem stores a `params` spec and writes its statement/answer/
 * solution with `{{ ... }}` placeholders holding expressions:
 *
 *   statement: "Solve for $x$: ${{a}}x {{signed(b)}} = {{c}}$"
 *   params: {
 *     vars: {
 *       a: { type: "int", min: 2, max: 9 },
 *       b: { type: "int", min: -9, max: 9, exclude: [0] },
 *       x: { type: "int", min: -6, max: 6, exclude: [0] },
 *       c: { type: "expr", expr: "a*x + b" }
 *     },
 *     constraints: ["a != 1"]
 *   }
 *
 * Because `{{` is scanned left-to-right and placeholders may not contain
 * braces, nesting inside LaTeX groups works: `\frac{{{a}}}{2}` renders as
 * `\frac{a-value}{2}`. Adding spaces (`\frac{ {{a}} }{2}`) is also fine.
 */

const MAX_DRAW_ATTEMPTS = 400;
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

class VariantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VariantError';
  }
}

/** Accept either `{ vars, constraints }` or a bare map of variable specs. */
function normaliseSpec(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { vars: {}, constraints: [] };
  }
  if (params.vars && typeof params.vars === 'object' && !Array.isArray(params.vars)) {
    return {
      vars: params.vars,
      constraints: Array.isArray(params.constraints) ? params.constraints : [],
    };
  }
  const { constraints, ...vars } = params;
  return {
    vars,
    constraints: Array.isArray(constraints) ? constraints : [],
  };
}

function resolveBound(bound, scope, label) {
  if (typeof bound === 'number') return bound;
  if (typeof bound === 'string') {
    const value = evaluate(bound, scope);
    if (typeof value !== 'number') throw new VariantError(`${label} must be numeric`);
    return value;
  }
  throw new VariantError(`${label} is required`);
}

function drawOne(name, spec, scope, rng) {
  const type = (spec && spec.type) || (spec && spec.expr ? 'expr' : 'int');
  switch (type) {
    case 'int': {
      const min = resolveBound(spec.min, scope, `${name}.min`);
      const max = resolveBound(spec.max, scope, `${name}.max`);
      const step = spec.step ? Math.abs(resolveBound(spec.step, scope, `${name}.step`)) : 1;
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      const slots = Math.floor((hi - lo) / step);
      if (slots < 0) throw new VariantError(`${name}: empty range`);
      return lo + rng.int(0, slots) * step;
    }
    case 'decimal': {
      const min = resolveBound(spec.min, scope, `${name}.min`);
      const max = resolveBound(spec.max, scope, `${name}.max`);
      const step = spec.step ? Math.abs(resolveBound(spec.step, scope, `${name}.step`)) : 0.1;
      const slots = Math.floor((Math.max(min, max) - Math.min(min, max)) / step);
      if (slots < 0) throw new VariantError(`${name}: empty range`);
      const raw = Math.min(min, max) + rng.int(0, slots) * step;
      return Number(raw.toFixed(9));
    }
    case 'choice': {
      if (!Array.isArray(spec.values) || spec.values.length === 0) {
        throw new VariantError(`${name}: choice needs a non-empty "values" array`);
      }
      return rng.pick(spec.values);
    }
    case 'expr': {
      if (typeof spec.expr !== 'string') throw new VariantError(`${name}: expr needs an "expr" string`);
      return evaluate(spec.expr, scope);
    }
    default:
      throw new VariantError(`${name}: unknown parameter type ${JSON.stringify(type)}`);
  }
}

function drawVariables(vars, rng) {
  const scope = {};
  for (const [name, rawSpec] of Object.entries(vars)) {
    const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : { type: 'expr', expr: String(rawSpec) };
    const exclude = Array.isArray(spec.exclude) ? spec.exclude : [];
    // Re-draw a single variable a bounded number of times to satisfy `exclude`,
    // rather than restarting the whole problem for a common case like "not 0".
    let value;
    let tries = 0;
    do {
      value = drawOne(name, spec, scope, rng);
      tries += 1;
    } while (exclude.includes(value) && tries < 100);
    if (exclude.includes(value)) {
      throw new VariantError(`${name}: could not satisfy "exclude" after 100 draws`);
    }
    scope[name] = value;
  }
  return scope;
}

/** Replace every `{{ expression }}` in `text` using `scope`. */
function substitute(text, scope) {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return text || '';
  return text.replace(PLACEHOLDER, (match, source) => {
    try {
      return formatValue(evaluate(source, scope));
    } catch (error) {
      if (error instanceof ExprError) {
        throw new VariantError(`in "${match}": ${error.message}`);
      }
      throw error;
    }
  });
}

/**
 * Build one concrete instance of `problem`.
 * Static problems pass through unchanged; template problems are drawn using
 * `seed`, so the same seed always yields the same instance.
 */
function instantiate(problem, seed = 1) {
  const isTemplate = problem.kind === 'template';
  if (!isTemplate) {
    return {
      statement: problem.statement || '',
      answer: problem.answer || '',
      solution: problem.solution || '',
      vars: {},
    };
  }

  const { vars, constraints } = normaliseSpec(problem.params);
  const rng = makeRng(seed);
  let scope = null;
  let lastFailure = null;

  for (let attempt = 0; attempt < MAX_DRAW_ATTEMPTS; attempt += 1) {
    const candidate = drawVariables(vars, rng);
    const failed = constraints.find((constraint) => {
      try {
        return !evaluateCondition(constraint, candidate);
      } catch (error) {
        lastFailure = `constraint "${constraint}": ${error.message}`;
        return true;
      }
    });
    if (!failed) {
      scope = candidate;
      break;
    }
    lastFailure = lastFailure || `constraint "${failed}" never satisfied`;
  }

  if (!scope) {
    throw new VariantError(
      `could not generate an instance after ${MAX_DRAW_ATTEMPTS} attempts (${lastFailure || 'constraints too tight'})`,
    );
  }

  return {
    statement: substitute(problem.statement, scope),
    answer: substitute(problem.answer, scope),
    solution: substitute(problem.solution, scope),
    vars: scope,
  };
}

module.exports = { instantiate, substitute, normaliseSpec, VariantError };
