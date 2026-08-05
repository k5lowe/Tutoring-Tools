'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * SQLite storage. The database is a single file under data/, which makes it easy
 * to back up or copy between machines.
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

const SCHEMA = `
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

CREATE INDEX IF NOT EXISTS idx_problems_subject    ON problems (subject);
CREATE INDEX IF NOT EXISTS idx_problems_topic      ON problems (topic);
CREATE INDEX IF NOT EXISTS idx_problems_difficulty ON problems (difficulty);
CREATE INDEX IF NOT EXISTS idx_problems_section    ON problems (source_book, source_section);
CREATE UNIQUE INDEX IF NOT EXISTS idx_problems_external_key
  ON problems (external_key) WHERE external_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS sets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL DEFAULT 'Untitled set',
  subject    TEXT    NOT NULL DEFAULT '',
  numbering  TEXT    NOT NULL DEFAULT 'sequential',
  start_at   INTEGER NOT NULL DEFAULT 1,
  versions   INTEGER NOT NULL DEFAULT 1,
  meta       TEXT    NOT NULL DEFAULT '{}',
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS set_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id             INTEGER NOT NULL REFERENCES sets (id)     ON DELETE CASCADE,
  problem_id         INTEGER NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
  position           INTEGER NOT NULL DEFAULT 0,
  seed               INTEGER NOT NULL DEFAULT 1,
  label_override     TEXT    NOT NULL DEFAULT '',
  override_statement TEXT    NOT NULL DEFAULT '',
  override_answer    TEXT    NOT NULL DEFAULT '',
  override_solution  TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_set_items_set ON set_items (set_id, position);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'practice',
  body       TEXT    NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_templates_kind ON templates (kind, is_default);
`;

let instance = null;

function open(filePath = DEFAULT_PATH) {
  if (!driver) driver = loadDriver();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = driver.create(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function getDb() {
  if (!instance) instance = open();
  return instance;
}

/** Open an isolated database — used by the tests. */
function openMemory() {
  if (!driver) driver = loadDriver();
  const db = driver.create(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
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
  getDb, open, openMemory, close, toId, parseJson, transaction, driverName, DEFAULT_PATH, SCHEMA,
};
