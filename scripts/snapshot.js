'use strict';

const snapshots = require('../server/lib/snapshots');
const { open, DEFAULT_PATH } = require('../server/db');

/**
 * Take a snapshot from the command line, or list the ones already taken.
 *
 *   npm run snapshot          take one now
 *   npm run snapshot -- list  show what is there
 *
 * Useful on its own, and useful from cron on a host where the app is not
 * running long enough for its own timer to fire.
 */

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function main() {
  const dir = snapshots.directory(DEFAULT_PATH);
  const listing = process.argv.includes('list');

  if (listing) {
    const all = snapshots.list(dir);
    if (all.length === 0) {
      console.log(`\n  No snapshots yet in ${dir}\n`);
      return;
    }
    console.log(`\n  ${all.length} snapshot(s) in ${dir}\n`);
    for (const entry of all) {
      console.log(`  ${entry.takenAt.toISOString().replace('T', ' ').slice(0, 19)}  `
        + `${human(entry.bytes).padStart(8)}  ${entry.reason}`);
      console.log(`      ${entry.name}`);
    }
    console.log('\n  Restore one with:  npm run restore -- <name>\n');
    return;
  }

  const db = open(DEFAULT_PATH);
  try {
    const result = snapshots.take(db, { dir, reason: 'manual' });
    if (result.error) {
      console.error(`\n  Could not write a snapshot: ${result.error}\n`);
      process.exitCode = 1;
      return;
    }
    const removed = snapshots.prune(dir);
    console.log(`\n  Wrote ${result.name} (${human(result.bytes)})`);
    console.log(`  ${snapshots.list(dir).length} snapshot(s) kept in ${dir}`);
    if (removed.length > 0) console.log(`  ${removed.length} aged out`);
    console.log('');
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { main };
