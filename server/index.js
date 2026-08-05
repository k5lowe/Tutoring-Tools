'use strict';

const { getDb, DEFAULT_PATH } = require('./db');
const { createApp } = require('./app');
const problems = require('./store/problems');
const pdf = require('./lib/pdf');
const { seedIfEmpty } = require('../scripts/seed');

const PORT = Number(process.env.PORT) || 4675;
const HOST = process.env.HOST || '127.0.0.1';

function main() {
  const db = getDb();

  // First run on a fresh machine should land on a usable bank, not an empty one.
  const added = seedIfEmpty(db);
  const app = createApp(db);

  const server = app.listen(PORT, HOST, () => {
    const { total } = problems.facets(db);
    console.log(`
  Tutoring Tools  ->  http://${HOST}:${PORT}

  database : ${DEFAULT_PATH}
  problems : ${total}${added ? ` (seeded ${added} starter problems)` : ''}
  pdf      : ${pdf.isAvailable() ? `${pdf.detectEngine().command} found — one-click PDF enabled` : 'no LaTeX engine found — .tex download and browser printing still work'}
`);
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
