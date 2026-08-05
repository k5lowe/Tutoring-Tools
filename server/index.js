'use strict';

const { getDb, driverName, DEFAULT_PATH } = require('./db');
const { createApp } = require('./app');
const problems = require('./store/problems');
const pdf = require('./lib/pdf');
const { seedIfEmpty } = require('../scripts/seed');

const PORT = Number(process.env.PORT) || 4675;
const HOST = process.env.HOST || '127.0.0.1';

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
  Tutoring Tools  ->  http://${HOST}:${PORT}

  database : ${DEFAULT_PATH}
  sqlite   : ${driverName()} on Node ${process.version}
  problems : ${total}${added ? ` (seeded ${added} starter problems)` : ''}
  pdf      : ${pdf.isAvailable() ? `${pdf.detectEngine().command} found — one-click PDF enabled` : 'no LaTeX engine found — .tex download and browser printing still work'}
`);
  });

  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') throw error;
    // Usually a second copy already running, which is worth saying plainly.
    console.error(`
  Port ${PORT} is already in use — Tutoring Tools may already be running.

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
