'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { transaction } = require('../server/db');
const problems = require('../server/store/problems');
const { instantiate } = require('../server/lib/variants');

/**
 * Loads the starter problem bank from data/seed/*.json.
 *
 * Every problem carries an `external_key`, so re-running the seed updates the
 * shipped problems in place instead of duplicating them. Problems you add
 * yourself have no key and are never touched.
 */

const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');

function readSeedFiles(directory = SEED_DIR) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const raw = fs.readFileSync(path.join(directory, name), 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(`${name}: invalid JSON — ${error.message}`);
      }
      const list = Array.isArray(parsed) ? parsed : parsed.problems || [];
      // A file-level `subject` saves repeating it on every problem.
      return list.map((problem) => ({
        subject: parsed.subject || '',
        ...problem,
        _file: name,
      }));
    });
}

/**
 * Verify a template problem can actually be generated before it lands in the
 * bank — a broken seed problem is much harder to debug once it is only a row.
 */
function check(problem) {
  if (problem.kind !== 'template') return null;
  try {
    for (const seed of [1, 2, 1337, 99991]) {
      instantiate(problem, seed);
    }
    return null;
  } catch (error) {
    return error.message;
  }
}

function seedAll(db, { force = false, verbose = false } = {}) {
  const incoming = readSeedFiles();
  const summary = { created: 0, updated: 0, skipped: 0, failed: [] };

  transaction(db, () => {
    for (const problem of incoming) {
      const problemError = check(problem);
      if (problemError) {
        summary.failed.push({ key: problem.external_key, message: problemError });
        continue;
      }
      const existing = problem.external_key
        ? db.prepare('SELECT id FROM problems WHERE external_key = ?').get(problem.external_key)
        : null;
      if (existing && !force) {
        summary.skipped += 1;
        continue;
      }
      const { created } = problems.upsert(db, problem);
      if (created) summary.created += 1;
      else summary.updated += 1;
      if (verbose) console.log(`  ${created ? 'added  ' : 'updated'} ${problem.external_key}`);
    }
  });

  return summary;
}

/**
 * Used on server start: deliver any shipped question this bank has not had.
 *
 * This used to run only on a completely empty bank, which meant a release that
 * added questions never reached anybody who already had some — an existing
 * bank simply stayed as it was, silently. Now it is additive.
 *
 * A key is recorded once delivered and never acted on again, so a question you
 * edited keeps your edit and a question you deleted stays deleted. Keys already
 * present in the bank are backfilled first, so upgrading an existing bank marks
 * what it has rather than overwriting it.
 */
function seedNew(db) {
  const summary = { created: 0, failed: [] };

  transaction(db, () => {
    db.exec(`INSERT OR IGNORE INTO seeded_keys (external_key)
             SELECT external_key FROM problems WHERE external_key IS NOT NULL`);

    const delivered = new Set(
      db.prepare('SELECT external_key FROM seeded_keys').all().map((row) => row.external_key),
    );
    const record = db.prepare('INSERT OR IGNORE INTO seeded_keys (external_key) VALUES (?)');

    for (const problem of readSeedFiles()) {
      if (!problem.external_key || delivered.has(problem.external_key)) continue;
      const problemError = check(problem);
      if (problemError) {
        summary.failed.push({ key: problem.external_key, message: problemError });
        continue;
      }
      problems.upsert(db, problem);
      record.run(problem.external_key);
      summary.created += 1;
    }
  });

  if (summary.failed.length > 0) {
    console.warn(`Warning: ${summary.failed.length} seed problem(s) failed validation:`);
    for (const failure of summary.failed) console.warn(`  ${failure.key}: ${failure.message}`);
  }
  return summary.created;
}

/** Kept for the tests and for anything that wants the old all-or-nothing rule. */
function seedIfEmpty(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM problems').get();
  if (Number(n) > 0) return 0;
  return seedNew(db);
}

function main() {
  const { getDb } = require('../server/db');
  const force = process.argv.includes('--force');
  const db = getDb();
  const summary = seedAll(db, { force, verbose: process.argv.includes('--verbose') });

  console.log(`
  seed complete
    created   : ${summary.created}
    updated   : ${summary.updated}
    unchanged : ${summary.skipped}${force ? '' : '  (re-run with --force to overwrite)'}
    failed    : ${summary.failed.length}`);

  for (const failure of summary.failed) {
    console.error(`    ! ${failure.key}: ${failure.message}`);
  }
  process.exit(summary.failed.length > 0 ? 1 : 0);
}

if (require.main === module) main();

module.exports = { seedAll, seedNew, seedIfEmpty, readSeedFiles, check };
