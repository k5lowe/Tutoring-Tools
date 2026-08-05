'use strict';

const { toId } = require('../db');
const { BUILTIN_TEMPLATES } = require('../templates/builtin');

const KINDS = ['practice', 'notes', 'answers'];

function row(record) {
  if (!record) return null;
  return {
    ...record,
    id: toId(record.id),
    is_default: Number(record.is_default) === 1,
    builtin: Number(record.builtin) === 1,
  };
}

function list(db, kind) {
  if (kind && KINDS.includes(kind)) {
    return db.prepare('SELECT * FROM templates WHERE kind = ? ORDER BY is_default DESC, name ASC')
      .all(kind).map(row);
  }
  return db.prepare('SELECT * FROM templates ORDER BY kind ASC, is_default DESC, name ASC')
    .all().map(row);
}

function get(db, id) {
  return row(db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(id)));
}

function getDefault(db, kind) {
  const wanted = KINDS.includes(kind) ? kind : 'practice';
  return row(
    db.prepare('SELECT * FROM templates WHERE kind = ? ORDER BY is_default DESC, id ASC LIMIT 1')
      .get(wanted),
  );
}

/**
 * Resolve the template to render with: an explicit id when given, otherwise the
 * default for the kind.
 */
function resolve(db, { id, kind }) {
  if (id) {
    const template = get(db, id);
    if (template) return template;
  }
  return getDefault(db, kind);
}

function create(db, input = {}) {
  const kind = KINDS.includes(input.kind) ? input.kind : 'practice';
  const result = db
    .prepare('INSERT INTO templates (name, kind, body, is_default, builtin) VALUES (?, ?, ?, 0, 0)')
    .run(String(input.name || 'Untitled template').trim(), kind, String(input.body || ''));
  const id = toId(result.lastInsertRowid);
  if (input.is_default) setDefault(db, id);
  return get(db, id);
}

function update(db, id, input = {}) {
  const existing = get(db, id);
  if (!existing) return null;
  const kind = KINDS.includes(input.kind) ? input.kind : existing.kind;
  db.prepare(`UPDATE templates SET name = ?, kind = ?, body = ?, updated_at = datetime('now')
              WHERE id = ?`)
    .run(
      String(input.name ?? existing.name).trim() || existing.name,
      kind,
      input.body == null ? existing.body : String(input.body),
      Number(id),
    );
  if (input.is_default) setDefault(db, id);
  return get(db, id);
}

/** Exactly one default per kind. */
function setDefault(db, id) {
  const template = get(db, id);
  if (!template) return null;
  db.prepare('UPDATE templates SET is_default = 0 WHERE kind = ?').run(template.kind);
  db.prepare('UPDATE templates SET is_default = 1 WHERE id = ?').run(Number(id));
  return get(db, id);
}

function remove(db, id) {
  const template = get(db, id);
  if (!template) return false;
  if (template.builtin) return false;
  db.prepare('DELETE FROM templates WHERE id = ?').run(Number(id));
  // Never leave a kind without a default.
  const fallback = getDefault(db, template.kind);
  if (fallback && !fallback.is_default) setDefault(db, fallback.id);
  return true;
}

/**
 * Restore a builtin template to its shipped body, for when an edit goes wrong.
 */
function reset(db, id) {
  const template = get(db, id);
  if (!template || !template.builtin) return null;
  const shipped = BUILTIN_TEMPLATES.find((candidate) => candidate.name === template.name);
  if (!shipped) return null;
  db.prepare("UPDATE templates SET body = ?, updated_at = datetime('now') WHERE id = ?")
    .run(shipped.body, Number(id));
  return get(db, id);
}

/** Seed the shipped templates. Existing rows are left alone. */
function ensureBuiltins(db) {
  const existing = db.prepare('SELECT name FROM templates WHERE builtin = 1').all()
    .map((record) => record.name);
  const insert = db.prepare(`INSERT INTO templates (name, kind, body, is_default, builtin)
                             VALUES (?, ?, ?, ?, 1)`);
  let added = 0;
  for (const template of BUILTIN_TEMPLATES) {
    if (existing.includes(template.name)) continue;
    insert.run(template.name, template.kind, template.body, template.is_default);
    added += 1;
  }
  return added;
}

module.exports = { list, get, getDefault, resolve, create, update, remove, reset, setDefault, ensureBuiltins, KINDS };
