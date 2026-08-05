'use strict';

const { toId } = require('../db');
const { requireWorkspace } = require('./problems');
const { BUILTIN_TEMPLATES } = require('../templates/builtin');

/**
 * Document templates, scoped per workspace: each tutor gets their own copy of
 * the shipped templates and can edit them without affecting anybody else.
 */

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

function list(db, workspaceId, kind) {
  const scope = requireWorkspace(workspaceId);
  if (kind && KINDS.includes(kind)) {
    return db.prepare(`SELECT * FROM templates WHERE workspace_id = ? AND kind = ?
                       ORDER BY is_default DESC, name ASC`)
      .all(scope, kind).map(row);
  }
  return db.prepare(`SELECT * FROM templates WHERE workspace_id = ?
                     ORDER BY kind ASC, is_default DESC, name ASC`)
    .all(scope).map(row);
}

function get(db, workspaceId, id) {
  return row(
    db.prepare('SELECT * FROM templates WHERE id = ? AND workspace_id = ?')
      .get(Number(id), requireWorkspace(workspaceId)),
  );
}

function getDefault(db, workspaceId, kind) {
  const wanted = KINDS.includes(kind) ? kind : 'practice';
  return row(
    db.prepare(`SELECT * FROM templates WHERE workspace_id = ? AND kind = ?
                ORDER BY is_default DESC, id ASC LIMIT 1`)
      .get(requireWorkspace(workspaceId), wanted),
  );
}

/**
 * Resolve the template to render with: an explicit id when given, otherwise the
 * default for the kind.
 */
function resolve(db, workspaceId, { id, kind }) {
  if (id) {
    const template = get(db, workspaceId, id);
    if (template) return template;
  }
  return getDefault(db, workspaceId, kind);
}

function create(db, workspaceId, input = {}) {
  const scope = requireWorkspace(workspaceId);
  const kind = KINDS.includes(input.kind) ? input.kind : 'practice';
  const result = db
    .prepare(`INSERT INTO templates (workspace_id, name, kind, body, is_default, builtin)
              VALUES (?, ?, ?, ?, 0, 0)`)
    .run(scope, String(input.name || 'Untitled template').trim(), kind, String(input.body || ''));
  const id = toId(result.lastInsertRowid);
  if (input.is_default) setDefault(db, scope, id);
  return get(db, scope, id);
}

function update(db, workspaceId, id, input = {}) {
  const scope = requireWorkspace(workspaceId);
  const existing = get(db, scope, id);
  if (!existing) return null;
  const kind = KINDS.includes(input.kind) ? input.kind : existing.kind;
  db.prepare(`UPDATE templates SET name = ?, kind = ?, body = ?, updated_at = datetime('now')
              WHERE id = ? AND workspace_id = ?`)
    .run(
      String(input.name ?? existing.name).trim() || existing.name,
      kind,
      input.body == null ? existing.body : String(input.body),
      Number(id),
      scope,
    );
  if (input.is_default) setDefault(db, scope, id);
  return get(db, scope, id);
}

/** Exactly one default per kind, per workspace. */
function setDefault(db, workspaceId, id) {
  const scope = requireWorkspace(workspaceId);
  const template = get(db, scope, id);
  if (!template) return null;
  db.prepare('UPDATE templates SET is_default = 0 WHERE workspace_id = ? AND kind = ?')
    .run(scope, template.kind);
  db.prepare('UPDATE templates SET is_default = 1 WHERE id = ? AND workspace_id = ?')
    .run(Number(id), scope);
  return get(db, scope, id);
}

function remove(db, workspaceId, id) {
  const scope = requireWorkspace(workspaceId);
  const template = get(db, scope, id);
  if (!template) return false;
  if (template.builtin) return false;
  db.prepare('DELETE FROM templates WHERE id = ? AND workspace_id = ?').run(Number(id), scope);
  // Never leave a kind without a default.
  const fallback = getDefault(db, scope, template.kind);
  if (fallback && !fallback.is_default) setDefault(db, scope, fallback.id);
  return true;
}

/**
 * Restore a builtin template to its shipped body, for when an edit goes wrong.
 */
function reset(db, workspaceId, id) {
  const scope = requireWorkspace(workspaceId);
  const template = get(db, scope, id);
  if (!template || !template.builtin) return null;
  const shipped = BUILTIN_TEMPLATES.find((candidate) => candidate.name === template.name);
  if (!shipped) return null;
  db.prepare("UPDATE templates SET body = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?")
    .run(shipped.body, Number(id), scope);
  return get(db, scope, id);
}

/** Seed the shipped templates into a workspace. Existing rows are left alone. */
function ensureBuiltins(db, workspaceId) {
  const scope = requireWorkspace(workspaceId);
  const existing = db
    .prepare('SELECT name FROM templates WHERE workspace_id = ? AND builtin = 1')
    .all(scope)
    .map((record) => record.name);
  const insert = db.prepare(`INSERT INTO templates (workspace_id, name, kind, body, is_default, builtin)
                             VALUES (?, ?, ?, ?, ?, 1)`);
  let added = 0;
  for (const template of BUILTIN_TEMPLATES) {
    if (existing.includes(template.name)) continue;
    insert.run(scope, template.name, template.kind, template.body, template.is_default);
    added += 1;
  }
  return added;
}

module.exports = {
  list, get, getDefault, resolve, create, update, remove, reset, setDefault, ensureBuiltins, KINDS,
};
