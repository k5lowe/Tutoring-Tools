'use strict';

const { makeRng } = require('./rng');

/**
 * Picks problems out of a filtered pool to fill a set.
 *
 * `distribution` controls the shape of the resulting worksheet:
 *   flat   – keep the pool's own order (usually textbook order)
 *   random – shuffle
 *   mixed  – round-robin across difficulty levels, so every set has a spread
 *   ramp   – easiest first, hardest last
 */

const DISTRIBUTIONS = ['mixed', 'ramp', 'random', 'flat'];

function shuffled(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function byDifficulty(list) {
  const buckets = new Map();
  for (const problem of list) {
    const level = Number(problem.difficulty) || 3;
    if (!buckets.has(level)) buckets.set(level, []);
    buckets.get(level).push(problem);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group);
}

function roundRobin(groups, count) {
  const out = [];
  let index = 0;
  while (out.length < count) {
    const before = out.length;
    for (const group of groups) {
      if (index < group.length) {
        out.push(group[index]);
        if (out.length >= count) break;
      }
    }
    if (out.length === before) break;
    index += 1;
  }
  return out;
}

/**
 * @returns {{ problems: object[], shortfall: number }} chosen problems in final
 *   order. Template problems may be reused (with different seeds) to reach
 *   `count` when the pool is too small and `allowRepeats` is set.
 */
function selectProblems(pool, options = {}) {
  const count = Math.max(1, Math.min(Math.floor(Number(options.count) || 10), 200));
  const distribution = DISTRIBUTIONS.includes(options.distribution) ? options.distribution : 'mixed';
  const rng = makeRng(options.seed || 1);
  const allowRepeats = options.allowRepeats !== false;

  let chosen;
  switch (distribution) {
    case 'flat':
      chosen = pool.slice(0, count);
      break;
    case 'random':
      chosen = shuffled(pool, rng).slice(0, count);
      break;
    case 'ramp':
      chosen = shuffled(pool, rng)
        .slice(0, count)
        .sort((a, b) => (Number(a.difficulty) || 3) - (Number(b.difficulty) || 3));
      break;
    default:
      chosen = roundRobin(byDifficulty(shuffled(pool, rng)), count);
      break;
  }

  const shortfall = count - chosen.length;
  if (shortfall > 0 && allowRepeats) {
    // Only templates can be repeated meaningfully: a fresh seed makes a fresh
    // problem. Repeating a static problem would just duplicate it.
    const templates = pool.filter((problem) => problem.kind === 'template');
    for (let i = 0; i < shortfall && templates.length > 0; i += 1) {
      chosen.push(templates[i % templates.length]);
    }
  }

  return { problems: chosen, shortfall: Math.max(0, count - chosen.length) };
}

module.exports = { selectProblems, DISTRIBUTIONS };
