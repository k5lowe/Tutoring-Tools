'use strict';

/**
 * A small in-memory sliding-window limiter.
 *
 * Used to cap how many workspaces one address can create. Each workspace is
 * seeded with the starter bank, so unbounded creation is a way to fill the
 * disk; this makes that tedious rather than free.
 *
 * State lives in this process, so it resets on restart and is per-instance.
 * That is the right weight for one small server. Running several instances, or
 * wanting limits that survive a deploy, would mean moving this to the database
 * or a shared cache.
 */

function createLimiter({ windowMs = 60 * 60 * 1000, max = 20, now = Date.now } = {}) {
  const hits = new Map();

  function sweep(cutoff) {
    for (const [key, times] of hits) {
      const kept = times.filter((time) => time > cutoff);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }

  return {
    /** Record an attempt. Returns false when the caller is over the limit. */
    take(key) {
      const current = now();
      const cutoff = current - windowMs;
      // Keep the map from growing without bound on a long-lived process.
      if (hits.size > 5000) sweep(cutoff);

      const times = (hits.get(key) || []).filter((time) => time > cutoff);
      if (times.length >= max) {
        hits.set(key, times);
        return false;
      }
      times.push(current);
      hits.set(key, times);
      return true;
    },
    /** How many attempts remain for this key. */
    remaining(key) {
      const cutoff = now() - windowMs;
      return Math.max(0, max - (hits.get(key) || []).filter((time) => time > cutoff).length);
    },
    reset() {
      hits.clear();
    },
    get size() {
      return hits.size;
    },
  };
}

module.exports = { createLimiter };
