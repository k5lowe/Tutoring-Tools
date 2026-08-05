'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { transaction, DEFAULT_WORKSPACE_ID } = require('../server/db');
const problems = require('../server/store/problems');
const templates = require('../server/store/templates');
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

function seedAll(db, workspaceId = DEFAULT_WORKSPACE_ID, { force = false, verbose = false } = {}) {
  const incoming = readSeedFiles();
  const summary = {
    created: 0, updated: 0, skipped: 0, failed: [], templatesAdded: 0,
  };

  summary.templatesAdded = templates.ensureBuiltins(db, workspaceId);

  transaction(db, () => {
    for (const problem of incoming) {
      const problemError = check(problem);
      if (problemError) {
        summary.failed.push({ key: problem.external_key, message: problemError });
        continue;
      }
      const existing = problem.external_key
        ? db.prepare('SELECT id FROM problems WHERE workspace_id = ? AND external_key = ?')
          .get(workspaceId, problem.external_key)
        : null;
      if (existing && !force) {
        summary.skipped += 1;
        continue;
      }
      const { created } = problems.upsert(db, workspaceId, problem);
      if (created) summary.created += 1;
      else summary.updated += 1;
      if (verbose) console.log(`  ${created ? 'added  ' : 'updated'} ${problem.external_key}`);
    }
  });

  return summary;
}

/** Used on server start: only populates a bank that is completely empty. */
function seedIfEmpty(db, workspaceId = DEFAULT_WORKSPACE_ID) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM problems WHERE workspace_id = ?')
    .get(workspaceId);
  if (Number(n) > 0) {
    templates.ensureBuiltins(db, workspaceId);
    return 0;
  }
  const summary = seedAll(db, workspaceId);
  if (summary.failed.length > 0) {
    console.warn(`Warning: ${summary.failed.length} seed problem(s) failed validation:`);
    for (const failure of summary.failed) console.warn(`  ${failure.key}: ${failure.message}`);
  }
  return summary.created;
}

function main() {
  const { getDb } = require('../server/db');
  const force = process.argv.includes('--force');
  const db = getDb();
  const summary = seedAll(db, DEFAULT_WORKSPACE_ID,
    { force, verbose: process.argv.includes('--verbose') });

  console.log(`
  seed complete
    created   : ${summary.created}
    updated   : ${summary.updated}
    unchanged : ${summary.skipped}${force ? '' : '  (re-run with --force to overwrite)'}
    templates : ${summary.templatesAdded} added
    failed    : ${summary.failed.length}`);

  for (const failure of summary.failed) {
    console.error(`    ! ${failure.key}: ${failure.message}`);
  }
  process.exit(summary.failed.length > 0 ? 1 : 0);
}

if (require.main === module) main();

/** Fill a brand-new workspace with the starter bank. */
function seedProblems(db, workspaceId) {
  return seedAll(db, workspaceId).created;
}

module.exports = { seedAll, seedIfEmpty, seedProblems, readSeedFiles, check };
