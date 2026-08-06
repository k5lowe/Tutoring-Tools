'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const snapshots = require('../server/lib/snapshots');
const { openRaw, DEFAULT_PATH } = require('../server/db');

/**
 * Put a snapshot back.
 *
 *   npm run restore -- <snapshot name>
 *   npm run restore -- latest
 *
 * The server has to be stopped first. SQLite keeps a write-ahead log in sidecar
 * files next to the database, and swapping the database out from under a
 * running process leaves those describing a bank that no longer exists.
 *
 * The snapshot is checked before anything is touched, and the database being
 * replaced is kept as `.replaced-<time>` — restoring the wrong one should not
 * be the mistake you cannot come back from.
 */

const PORT = Number(process.env.PORT) || 4675;

/** Is something already listening? A running server makes this unsafe. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 700);
  });
}

function usage(dir) {
  const all = snapshots.list(dir);
  console.log('\n  Usage:  npm run restore -- <snapshot name>');
  console.log('          npm run restore -- latest\n');
  if (all.length === 0) {
    console.log(`  No snapshots in ${dir}\n`);
    return;
  }
  console.log(`  Available in ${dir}:\n`);
  for (const entry of all.slice(0, 15)) {
    console.log(`    ${entry.name}   (${entry.reason}, `
      + `${entry.takenAt.toISOString().replace('T', ' ').slice(0, 19)})`);
  }
  if (all.length > 15) console.log(`    … and ${all.length - 15} more`);
  console.log('');
}

async function main() {
  const dir = snapshots.directory(DEFAULT_PATH);
  const asked = process.argv.slice(2).find((argument) => !argument.startsWith('-'));

  if (!asked) {
    usage(dir);
    process.exitCode = 1;
    return;
  }

  const all = snapshots.list(dir);
  const entry = asked === 'latest' ? all[0] : all.find((one) => one.name === asked);
  if (!entry) {
    console.error(`\n  No snapshot called "${asked}".`);
    usage(dir);
    process.exitCode = 1;
    return;
  }

  if (await portInUse(PORT)) {
    console.error(`
  Something is listening on port ${PORT} — the question bank looks like it is
  still running. Stop it first, then run this again.

  Restoring underneath a running server would leave its write-ahead log
  describing a database that no longer exists.
`);
    process.exitCode = 1;
    return;
  }

  const file = path.join(dir, entry.name);
  let result;
  try {
    result = snapshots.restore(file, DEFAULT_PATH, openRaw);
  } catch (error) {
    console.error(`\n  Restore refused: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`
  Restored ${entry.name}
    taken    : ${entry.takenAt.toISOString().replace('T', ' ').slice(0, 19)} (${entry.reason})
    questions: ${result.questions}
    database : ${DEFAULT_PATH}`);
  if (result.replaced) {
    console.log(`    previous : kept at ${path.basename(result.replaced)}`);
  }
  console.log('\n  Start the bank again with:  npm start\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n  Restore failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, portInUse };
