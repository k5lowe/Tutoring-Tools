'use strict';

const { getDb, driverName, DEFAULT_PATH } = require('./db');
const { createApp } = require('./app');
const problems = require('./store/problems');
const { seedIfEmpty } = require('../scripts/seed');

const PORT = Number(process.env.PORT) || 4675;
const MULTI_USER = process.env.MULTI_USER === '1';
// Local runs stay on the loopback address deliberately. A hosted instance has
// to accept traffic from the platform's proxy, so it binds to all interfaces.
const HOST = process.env.HOST || (MULTI_USER ? '0.0.0.0' : '127.0.0.1');

function describeEditing() {
  if (!MULTI_USER) return 'unlocked (running locally, so the bank is yours to edit)';
  if (!process.env.ADMIN_KEY) {
    return 'locked with no owner key set — nobody can edit the bank';
  }
  return 'read-only for visitors; sign in with ADMIN_KEY to edit';
}

function main() {
  let db;
  try {
    db = getDb();
  } catch (error) {
    // Missing SQLite driver is a setup problem, not a crash: say what to do
    // about it rather than printing a stack trace.
    const indented = error.message.split('\n').map((line) => `  ${line}`).join('\n');
    console.error(`\n  Tutoring Tools could not start.\n\n${indented}`);
    process.exit(1);
  }

  // First run on a fresh machine should land on a usable bank, not an empty one.
  const added = seedIfEmpty(db);
  const app = createApp(db);

  const server = app.listen(PORT, HOST, () => {
    const { total } = problems.facets(db);
    console.log(`
  Question bank  ->  http://${HOST}:${PORT}

  database : ${DEFAULT_PATH}
  sqlite   : ${driverName()} on Node ${process.version}
  questions: ${total}${added ? ` (seeded ${added} starter questions)` : ''}
  editing  : ${describeEditing()}
`);
  });

  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') throw error;
    // Usually a second copy already running, which is worth saying plainly.
    console.error(`
  Port ${PORT} is already in use — the question bank may already be running.

  Try opening http://${HOST}:${PORT}, or start it on another port:
      PowerShell   $env:PORT=4676; npm start
      macOS/Linux  PORT=4676 npm start
`);
    process.exit(1);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
