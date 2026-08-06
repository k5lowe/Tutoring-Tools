'use strict';

const { toId, parseJson } = require('../db');

/**
 * A record of what each bulk import did, so it can be undone.
 *
 * The check before an import catches questions that are broken. It cannot catch
 * a question that is valid but filed wrong — a single typo in an `@` line
 * misfiles everything below it, and every one of those questions renders
 * perfectly in the preview. That mistake is only visible later, which is why
 * there is a way back.
 *
 * Two things are recorded: the ids of rows inserted, and a full copy of any row
 * overwritten (an import matches on `external_key`, so re-importing edits rows
 * in place). Undoing deletes the first and restores the second, which puts the
 * bank back exactly as it was rather than approximately.
 */

const COLUMNS = [
  'subject', 'topic', 'subtopic', 'difficulty', 'kind', 'statement', 'answer', 'solution',
  'params', 'tags', 'source_book', 'source_edition', 'source_chapter', 'source_section',
  'source_number', 'notes', 'archived', 'external_key', 'created_at', 'updated_at',
];

function row(record) {
  if (!record) return null;
  const createdIds = parseJson(record.created_ids, []);
  const replaced = parseJson(record.replaced, []);
  return {
    id: toId(record.id),
    created_at: record.created_at,
    source: record.source,
    created: createdIds.length,
    replaced: replaced.length,
    undone_at: record.undone_at || null,
    createdIds,
    replacedRows: replaced,
  };
}

/** Everything needed to undo an import, captured as it happens. */
function record(db, { source = 'text', createdIds = [], replaced = [] }) {
  const result = db
    .prepare('INSERT INTO imports (source, created_ids, replaced) VALUES (?, ?, ?)')
    .run(String(source), JSON.stringify(createdIds), JSON.stringify(replaced));
  return get(db, toId(result.lastInsertRowid));
}

function get(db, id) {
  return row(db.prepare('SELECT * FROM imports WHERE id = ?').get(Number(id)));
}

/**
 * Recent imports, newest first, without the bulky undo payload — this feeds a
 * list in the UI, which only needs the counts.
 */
function recent(db, limit = 10) {
  const capped = Math.min(Math.max(Number(limit) || 10, 1), 50);
  return db
    .prepare('SELECT * FROM imports ORDER BY id DESC LIMIT ?')
    .all(capped)
    .map(row)
    .map(({ createdIds, replacedRows, ...summary }) => summary);
}

/** The most recent import that has not already been taken back. */
function lastUndoable(db) {
  return row(
    db.prepare('SELECT * FROM imports WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1').get(),
  );
}

/**
 * Put the bank back to before this import ran.
 *
 * Rows the import created are deleted; rows it overwrote are written back from
 * the copy taken at the time. A created row that has since been deleted by hand
 * simply is not there to delete, which is not an error — the end state is the
 * one asked for either way.
 */
function undo(db, id) {
  const entry = get(db, id);
  if (!entry) return null;
  if (entry.undone_at) return { ...entry, removed: 0, restored: 0, alreadyUndone: true };

  let removed = 0;
  if (entry.createdIds.length > 0) {
    const placeholders = entry.createdIds.map(() => '?').join(', ');
    removed = toId(
      db.prepare(`DELETE FROM problems WHERE id IN (${placeholders})`)
        .run(...entry.createdIds.map(Number)).changes,
    );
  }

  let restored = 0;
  const restore = db.prepare(
    `UPDATE problems SET ${COLUMNS.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
  );
  for (const previous of entry.replacedRows) {
    restored += restore.run(
      ...COLUMNS.map((column) => {
        const value = previous[column];
        if (column === 'params' || column === 'tags') {
          return typeof value === 'string' ? value : JSON.stringify(value ?? (column === 'tags' ? [] : {}));
        }
        if (column === 'archived') return value ? 1 : 0;
        if (column === 'external_key') return value == null ? null : String(value);
        return value == null ? '' : String(value);
      }),
      Number(previous.id),
    ).changes;
  }

  db.prepare("UPDATE imports SET undone_at = datetime('now') WHERE id = ?").run(Number(id));
  return { ...get(db, id), removed, restored, alreadyUndone: false };
}

module.exports = { record, get, recent, lastUndoable, undo };
