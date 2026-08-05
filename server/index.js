'use strict';

const { getDb, driverName, DEFAULT_PATH, DEFAULT_WORKSPACE_ID } = require('./db');
const { createApp } = require('./app');
const problems = require('./store/problems');
const pdf = require('./lib/pdf');
const { seedIfEmpty } = require('../scripts/seed');

const PORT = Number(process.env.PORT) || 4675;
const MULTI_USER = process.env.MULTI_USER === '1';
// Local runs stay on the loopback address deliberately. A hosted instance has
// to accept traffic from the platform's proxy, so it binds to all interfaces.
const HOST = process.env.HOST || (MULTI_USER ? '0.0.0.0' : '127.0.0.1');

const PDF_ENABLED = process.env.ALLOW_PDF === '1' || !MULTI_USER;

function describePdf() {
  if (!PDF_ENABLED) {
    return 'disabled for hosting (user-written LaTeX would run on this server) '
      + '— .tex download and browser printing still work';
  }
  if (!pdf.isAvailable()) {
    return 'no LaTeX engine found — .tex download and browser printing still work';
  }
  return `${pdf.detectEngine().command} found — one-click PDF enabled`;
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
    const { total } = problems.facets(db, DEFAULT_WORKSPACE_ID);
    console.log(`
  Tutoring Tools  ->  http://${HOST}:${PORT}

  mode     : ${MULTI_USER ? 'hosted — a private workspace per visitor' : 'local — single user'}
  database : ${DEFAULT_PATH}
  sqlite   : ${driverName()} on Node ${process.version}
  problems : ${total}${added ? ` (seeded ${added} starter problems)` : ''}
  pdf      : ${describePdf()}
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
