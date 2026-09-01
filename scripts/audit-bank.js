'use strict';

const { getDb } = require('../server/db');
const { readSeedFiles } = require('./seed');

/**
 * Explain what is in a bank and where each question came from.
 *
 *   npm run audit
 *   npm run audit -- --delete-orphans
 *
 * A bank does not have to match the shipped seed, and the difference is worth
 * being able to see rather than guess at. Three things end up in a bank:
 *
 *   - questions shipped in data/seed, matched by external_key;
 *   - questions written on the website, which have no external_key at all;
 *   - questions shipped by an *earlier* release whose key has since changed.
 *
 * The third kind is the one that surprises people. Seeding is additive and
 * keyed, so a question is delivered once and never revisited. Renaming a
 * subtopic changes the derived key, which means the next upgrade delivers the
 * renamed question as a new one and leaves the old copy sitting there. The
 * bank then holds both, and the count runs ahead of a fresh install.
 *
 * Orphans that you have not edited are safe to delete: an identical copy is
 * already in the bank under the current key. Ones you have edited are listed
 * separately and never deleted, because your edit is the only copy of itself.
 */

// Content only, deliberately not subject/topic/subtopic. Renaming a subtopic
// is the commonest reason a key changes, and the renamed question is then the
// same question -- classifying it as "edited" would be exactly backwards.
const FIELDS = ['statement', 'answer', 'solution'];

const same = (a, b) => FIELDS.every((f) => String(a[f] ?? '').trim() === String(b[f] ?? '').trim());

function audit(db) {
  const shipped = new Map();
  for (const problem of readSeedFiles()) {
    if (problem.external_key) shipped.set(problem.external_key, problem);
  }

  const rows = db.prepare(
    `SELECT id, external_key, subject, topic, subtopic, statement, answer, solution, archived
     FROM problems ORDER BY subject, topic, subtopic, id`,
  ).all();

  const out = {
    total: rows.length,
    live: rows.filter((r) => Number(r.archived) !== 1).length,
    current: [],
    authored: [],
    orphanClean: [],
    orphanEdited: [],
    missing: [],
  };

  for (const row of rows) {
    if (!row.external_key) { out.authored.push(row); continue; }
    const seed = shipped.get(row.external_key);
    if (seed) { out.current.push(row); continue; }
    // The key is not in any seed file any more.
    const twin = [...shipped.values()].find((s) => same(s, row));
    if (twin) out.orphanClean.push({ row, twin });
    else out.orphanEdited.push(row);
  }

  const held = new Set(rows.map((r) => r.external_key).filter(Boolean));
  for (const [key, problem] of shipped) {
    if (!held.has(key)) out.missing.push({ key, problem });
  }
  return out;
}

function describe(row) {
  const where = `${row.subject} > ${row.topic} > ${row.subtopic}`;
  const text = String(row.statement).replace(/\s+/g, ' ').trim();
  return `${where}\n           ${text.length > 76 ? `${text.slice(0, 75)}…` : text}`;
}

function main() {
  const db = getDb();
  const result = audit(db);
  const doDelete = process.argv.includes('--delete-orphans');
  // The reworded ones cannot be proved superseded, so removing them is a
  // separate, louder flag rather than a surprise inside the first one.
  const doDeleteAll = process.argv.includes('--delete-superseded');

  console.log(`
  bank total            : ${result.total}${result.total === result.live ? '' : `  (${result.live} not archived)`}
  shipped, current key  : ${result.current.length}
  written on the website: ${result.authored.length}
  superseded copies     : ${result.orphanClean.length + result.orphanEdited.length}
  shipped but not here  : ${result.missing.length}   (deleted, or never delivered)`);

  if (result.orphanClean.length > 0) {
    console.log(`\n  ${result.orphanClean.length} superseded copy(ies), unedited — the same question `
      + 'is already here under its current key:');
    for (const { row, twin } of result.orphanClean) {
      console.log(`      #${row.id}  ${row.external_key}`);
      console.log(`           now shipped as ${twin.external_key}`);
      console.log(`           ${describe(row)}`);
    }
    if (!doDelete && !doDeleteAll) {
      console.log('\n      Re-run with --delete-orphans to remove these.');
    }
  }

  if (result.orphanEdited.length > 0) {
    console.log(`\n  ${result.orphanEdited.length} superseded copy(ies) that differ from anything `
      + 'shipped. These are never deleted automatically — the version here may be yours:');
    for (const row of result.orphanEdited) {
      console.log(`      #${row.id}  ${row.external_key}\n           ${describe(row)}`);
    }
    if (!doDeleteAll) {
      console.log('\n      Read these before removing anything. If none of them is your own '
        + 'work,\n      --delete-superseded removes every superseded copy, reworded ones included.');
    }
  }

  const doomed = [
    ...(doDelete || doDeleteAll ? result.orphanClean.map((o) => o.row) : []),
    ...(doDeleteAll ? result.orphanEdited : []),
  ];
  if (doomed.length > 0) {
    const remove = db.prepare('DELETE FROM problems WHERE id = ?');
    // The key stays recorded in seeded_keys on purpose. That table is what
    // makes a deletion stick: if the key were forgotten and some later release
    // reused that subtopic name, seeding would hand the question back, which is
    // exactly the duplicate this command exists to clear up.
    for (const row of doomed) remove.run(row.id);
    console.log(`\n  Deleted ${doomed.length}. Bank now holds `
      + `${db.prepare('SELECT COUNT(*) AS n FROM problems').get().n}.`);
  }
  console.log('');
}

if (require.main === module) main();

module.exports = { audit };
