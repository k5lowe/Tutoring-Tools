'use strict';

/**
 * Deterministic, seeded PRNG (mulberry32).
 *
 * Reproducibility is a hard requirement here: a worksheet and its answer key
 * are rendered by separate requests, so the same (problem, seed) pair must
 * always produce the same instantiated problem.
 */
function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** Uniform integer in [min, max] inclusive. */
    int(min, max) {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      if (hi < lo) return lo;
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    /** Uniform pick from an array. */
    pick(list) {
      if (!Array.isArray(list) || list.length === 0) return undefined;
      return list[Math.floor(next() * list.length)];
    },
  };
}

/** Random 31-bit seed, used when creating new set items. */
function randomSeed() {
  return Math.floor(Math.random() * 0x7ffffffe) + 1;
}

module.exports = { makeRng, randomSeed };
