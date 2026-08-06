'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Point-in-time copies of the bank.
 *
 * The value of this app is a few thousand questions written by hand over
 * months, and until now they lived in exactly one file with no copy anywhere.
 * A snapshot is taken with SQLite's `VACUUM INTO`, which writes a complete,
 * consistent database file without stopping the server — so a snapshot is not
 * an export needing re-import, it is a bank you can open directly.
 *
 * Snapshots are taken on a timer, and before anything destructive. That second
 * one matters most: bulk delete has no undo of its own, so the snapshot taken
 * immediately before it is the way back.
 *
 * They land beside the live database by default, which puts them on the same
 * persistent disk when hosted. That covers a bad import, a mis-clicked delete
 * and file corruption — the likely failures — but not the loss of the disk
 * itself. Copy them somewhere else for that; `GET /api/snapshots/:name` hands
 * one over as a download.
 */

// Millisecond precision, so two snapshots a moment apart still sort by when
// they were taken rather than by what they were called. The milliseconds are
// optional so names written before they were added still parse.
const FILE = /^bank-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z-([a-z0-9-]+?)(?:-(\d+))?\.db$/;

/** Everything newer than this is kept regardless of the rest of the policy. */
const RECENT_MS = 48 * 60 * 60 * 1000;
const DAILY_KEEP = 14;
const WEEKLY_KEEP = 8;

/** Where snapshots live: beside the database unless told otherwise. */
function directory(dbPath) {
  return process.env.TUTORING_TOOLS_SNAPSHOTS
    || path.join(path.dirname(dbPath), 'snapshots');
}

/** Reasons become part of a filename, so they have to survive being one. */
function slug(reason) {
  const cleaned = String(reason || 'manual').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 32);
  return cleaned || 'manual';
}

function stamp(date) {
  return date.toISOString().replace(/[-:.]/g, '');
}

function parseName(name) {
  const match = FILE.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, ms, reason] = match;
  return {
    name,
    reason,
    takenAt: new Date(Date.UTC(
      Number(year), Number(month) - 1, Number(day),
      Number(hour), Number(minute), Number(second), Number(ms || 0),
    )),
  };
}

/**
 * Write a snapshot. Returns null when snapshots are switched off.
 *
 * Failure is reported, never thrown: a backup that cannot be written is worth
 * knowing about, but it is not a reason to fail the import or the delete that
 * triggered it — that would turn a missing safety net into an outage.
 */
function take(db, { dir, reason = 'manual', now = new Date() } = {}) {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const base = `bank-${stamp(now)}-${slug(reason)}`;
    // Two snapshots in the same second would collide, and VACUUM INTO refuses
    // to overwrite rather than silently replacing a good backup.
    let file = path.join(dir, `${base}.db`);
    for (let n = 2; fs.existsSync(file) && n < 100; n += 1) {
      file = path.join(dir, `${base}-${n}.db`);
    }
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const { size } = fs.statSync(file);
    return { name: path.basename(file), file, bytes: size, takenAt: now, reason: slug(reason) };
  } catch (error) {
    return { error: error.message, reason: slug(reason), takenAt: now };
  }
}

/** Snapshots on disk, newest first. Anything not named like one is ignored. */
function list(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(parseName)
    .filter(Boolean)
    .map((entry) => {
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(dir, entry.name)).size;
      } catch {
        // Vanished between listing and stat; report it as empty rather than throw.
      }
      return { ...entry, bytes };
    })
    .sort((a, b) => b.takenAt - a.takenAt || b.name.localeCompare(a.name));
}

const dayKey = (date) => date.toISOString().slice(0, 10);

/** ISO week, so "one per week" does not drift with the month. */
function weekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

/**
 * Which snapshots to keep: everything from the last two days, then the newest
 * of each of the last fourteen days present, then the newest of each of the
 * last eight weeks present.
 *
 * Deliberately counted over the snapshots that exist rather than over the
 * calendar. A server that was switched off for a month should come back to a
 * month of history, not to fourteen empty days that have quietly aged
 * everything out.
 */
function keepers(entries, now = new Date()) {
  const keep = new Set();
  const cutoff = now.getTime() - RECENT_MS;

  for (const entry of entries) {
    if (entry.takenAt.getTime() >= cutoff) keep.add(entry.name);
  }

  const newestPer = (keyOf, limit) => {
    const seen = new Map();
    for (const entry of entries) {
      const key = keyOf(entry.takenAt);
      if (!seen.has(key)) seen.set(key, entry.name);
    }
    for (const name of [...seen.values()].slice(0, limit)) keep.add(name);
  };

  // `entries` is newest-first, so the first seen in each group is the newest.
  newestPer(dayKey, DAILY_KEEP);
  newestPer(weekKey, WEEKLY_KEEP);
  return keep;
}

/** Delete the snapshots the policy does not keep. Returns what went. */
function prune(dir, { now = new Date() } = {}) {
  const entries = list(dir);
  const keep = keepers(entries, now);
  const removed = [];
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry.name));
      removed.push(entry.name);
    } catch {
      // A snapshot that cannot be deleted is clutter, not a failure.
    }
  }
  return removed;
}

/**
 * A snapshot is only a backup if it opens and has questions in it.
 *
 * `openDb` must open the file untouched — the app's own `open()` creates any
 * missing tables, which would quietly turn "this is not a bank" into "this is
 * an empty bank" and write to the file while doing it.
 */
function verify(file, openDb) {
  const db = openDb(file);
  try {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'problems'",
    ).get();
    if (!table) throw new Error('this file has no problems table — it is not a bank snapshot');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM problems').get();
    return { questions: typeof n === 'bigint' ? Number(n) : n };
  } finally {
    db.close();
  }
}

/**
 * Replace the live database with a snapshot.
 *
 * The server must not be running: SQLite's write-ahead log lives in sidecar
 * files, and a stale `-wal` left beside a swapped-in database would be replayed
 * over the top of it. They are removed here, and the database being replaced is
 * kept as `.replaced-<time>` rather than destroyed — restoring the wrong
 * snapshot should not be the mistake you cannot come back from.
 */
function restore(file, dbPath, openDb) {
  if (!fs.existsSync(file)) throw new Error(`No such snapshot: ${file}`);
  const { questions } = verify(file, openDb);

  let kept = null;
  if (fs.existsSync(dbPath)) {
    kept = `${dbPath}.replaced-${stamp(new Date())}`;
    fs.copyFileSync(dbPath, kept);
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(file, dbPath);
  for (const sidecar of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + sidecar)) fs.unlinkSync(dbPath + sidecar);
  }
  return { questions, replaced: kept };
}

/**
 * Take a snapshot now and every `hours` after. Returns a stop function.
 * `hours: 0` switches scheduled snapshots off; the ones taken before a
 * destructive action still happen.
 */
function schedule(db, { dir, hours = 24, onSnapshot = () => {} } = {}) {
  const first = take(db, { dir, reason: 'startup' });
  onSnapshot(first);
  if (first && !first.error) prune(dir);
  if (!hours || hours <= 0) return () => {};

  const timer = setInterval(() => {
    const result = take(db, { dir, reason: 'scheduled' });
    onSnapshot(result);
    if (result && !result.error) prune(dir);
  }, hours * 60 * 60 * 1000);
  // Never a reason to hold the process open.
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  directory, take, list, prune, keepers, restore, verify, schedule, parseName, slug,
  RECENT_MS, DAILY_KEEP, WEEKLY_KEEP,
};
