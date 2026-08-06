'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * SQLite storage for the question bank. One table, one file under data/, which
 * makes it easy to back up or copy between machines.
 *
 * Node 22.5+ ships SQLite in the standard library (`node:sqlite`), which is the
 * preferred driver: no native build step at all. Node 20 has no such module, so
 * we fall back to the `better-sqlite3` package, declared as an optional
 * dependency. Both expose the same small surface used here — `exec`, `prepare`,
 * `close`, and a `run()` returning `{ changes, lastInsertRowid }` — so nothing
 * else in the app needs to know which one is active.
 */

function loadDriver() {
  try {
    // eslint-disable-next-line global-require -- probing for an optional builtin.
    const { DatabaseSync } = require('node:sqlite');
    return { name: 'node:sqlite', create: (file) => new DatabaseSync(file) };
  } catch (error) {
    // Only "this Node has no such module" is a reason to look elsewhere.
    if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && error.code !== 'MODULE_NOT_FOUND') throw error;
  }

  try {
    // eslint-disable-next-line global-require -- optional dependency.
    const Database = require('better-sqlite3');
    return { name: 'better-sqlite3', create: (file) => new Database(file) };
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }

  throw new Error(
    `No SQLite driver available on Node ${process.version}.\n\n`
    + '  Either upgrade Node to 22.5 or newer, which includes SQLite:\n'
    + '      https://nodejs.org/en/download\n\n'
    + '  Or install the fallback driver for the Node you have:\n'
    + '      npm install better-sqlite3\n',
  );
}

let driver = null;

/** Which SQLite driver is in use — reported on startup. */
function driverName() {
  if (!driver) driver = loadDriver();
  return driver.name;
}

const DEFAULT_PATH = process.env.TUTORING_TOOLS_DB
  || path.join(__dirname, '..', 'data', 'tutoring-tools.db');

const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS problems (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subject         TEXT    NOT NULL DEFAULT '',
  topic           TEXT    NOT NULL DEFAULT '',
  subtopic        TEXT    NOT NULL DEFAULT '',
  difficulty      INTEGER NOT NULL DEFAULT 3,
  kind            TEXT    NOT NULL DEFAULT 'static',
  statement       TEXT    NOT NULL DEFAULT '',
  answer          TEXT    NOT NULL DEFAULT '',
  solution        TEXT    NOT NULL DEFAULT '',
  params          TEXT    NOT NULL DEFAULT '{}',
  tags            TEXT    NOT NULL DEFAULT '[]',
  source_book     TEXT    NOT NULL DEFAULT '',
  source_edition  TEXT    NOT NULL DEFAULT '',
  source_chapter  TEXT    NOT NULL DEFAULT '',
  source_section  TEXT    NOT NULL DEFAULT '',
  source_number   TEXT    NOT NULL DEFAULT '',
  notes           TEXT    NOT NULL DEFAULT '',
  archived        INTEGER NOT NULL DEFAULT 0,
  external_key    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- What each bulk import did, so it can be taken back.
--
-- The check before an import catches questions that are broken. It cannot catch
-- a question that is perfectly valid and filed wrong, which is the mistake this
-- format makes easiest: one typo in an "@" line quietly misfiles everything
-- below it. So an import records the rows it inserted, and a full copy of any
-- row it overwrote, and undoing it puts the bank back exactly as it was.
-- Which shipped questions have already been delivered to this bank.
--
-- Seeding used to run only on a completely empty bank, so a release that added
-- questions never reached anyone who already had some. Recording the keys makes
-- it additive instead: a new release brings its new questions, and a question
-- you edited or deleted is left alone, because its key is already here.
CREATE TABLE IF NOT EXISTS seeded_keys (
  external_key TEXT PRIMARY KEY,
  applied_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  source      TEXT    NOT NULL DEFAULT 'text',
  created_ids TEXT    NOT NULL DEFAULT '[]',
  replaced    TEXT    NOT NULL DEFAULT '[]',
  undone_at   TEXT
);
`;

const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_problems_subject    ON problems (subject);
CREATE INDEX IF NOT EXISTS idx_problems_topic      ON problems (topic);
CREATE INDEX IF NOT EXISTS idx_problems_difficulty ON problems (difficulty);
CREATE INDEX IF NOT EXISTS idx_problems_section    ON problems (source_book, source_section);
CREATE UNIQUE INDEX IF NOT EXISTS idx_problems_external_key
  ON problems (external_key) WHERE external_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_imports_recent ON imports (created_at DESC);
`;

/** The whole schema, for anything that wants it in one piece. */
const SCHEMA = `${SCHEMA_TABLES}\n${SCHEMA_INDEXES}`;

let instance = null;

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

/**
 * Bring an older database up to the current schema.
 *
 * Earlier versions of this app also generated worksheets, so a database from
 * one of those has `sets`, `set_items`, `templates` and `workspaces` tables and
 * a `workspace_id` column on problems. None of that is used now. The tables are
 * left in place rather than dropped — they cost nothing, and deleting somebody's
 * saved work as a side effect of an upgrade is not a decision this function
 * should make. The column keeps its default so inserts that ignore it still
 * satisfy the old unique index.
 */
function migrate(db) {
  if (!columnNames(db, 'problems').includes('workspace_id')) return;
  // An old database indexes (workspace_id, external_key); a new one indexes
  // external_key alone. Both enforce what the app needs, so leave it be.
  db.exec('UPDATE problems SET workspace_id = 1 WHERE workspace_id IS NULL');
}

function open(filePath = DEFAULT_PATH) {
  if (!driver) driver = loadDriver();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = driver.create(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_TABLES);
  migrate(db);
  db.exec(SCHEMA_INDEXES);
  return db;
}

function getDb() {
  if (!instance) instance = open();
  return instance;
}

/**
 * Open a database file exactly as it is: no schema, no migration, no changes.
 *
 * `open()` creates any missing tables, which is right for the live database and
 * wrong for inspecting a file you are not sure about — it would "repair" a
 * holiday photo into something that passes for a bank. Anything checking
 * whether a file really is a question bank has to use this.
 */
function openRaw(filePath) {
  if (!driver) driver = loadDriver();
  return driver.create(filePath);
}

/** Open an isolated database — used by the tests. */
function openMemory() {
  if (!driver) driver = loadDriver();
  const db = driver.create(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_TABLES);
  db.exec(SCHEMA_INDEXES);
  return db;
}

function close() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** node:sqlite can hand back BigInt row ids; normalise to Number. */
function toId(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Run `fn` inside a transaction, rolling back on error. */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed rollback should not mask the original error.
    }
    throw error;
  }
}

module.exports = {
  getDb, open, openRaw, openMemory, close, toId, parseJson, transaction, driverName, migrate,
  DEFAULT_PATH, SCHEMA,
};
