'use strict';

const { toId, parseJson, transaction } = require('../db');
const { randomSeed } = require('../lib/rng');
const { MODES } = require('../lib/numbering');
const { requireWorkspace } = require('./problems');

/**
 * Sets and their items, scoped per workspace.
 *
 * `set_items` has no workspace column of its own — it inherits scope from its
 * set, and every exported function here checks that the set belongs to the
 * caller's workspace before touching its items. Problems added to a set are
 * filtered to the same workspace too, so a set can never come to reference
 * someone else's problem.
 */

const ITEM_QUERY = `
  SELECT
    si.id                 AS item_id,
    si.set_id             AS set_id,
    si.problem_id         AS problem_id,
    si.position           AS position,
    si.seed               AS seed,
    si.label_override     AS label_override,
    si.override_statement AS override_statement,
    si.override_answer    AS override_answer,
    si.override_solution  AS override_solution,
    p.subject, p.topic, p.subtopic, p.difficulty, p.kind,
    p.statement, p.answer, p.solution, p.params, p.tags,
    p.source_book, p.source_edition, p.source_chapter, p.source_section, p.source_number,
    p.notes
  FROM set_items si
  JOIN problems p ON p.id = si.problem_id
  WHERE si.set_id = ?
  ORDER BY si.position ASC, si.id ASC
`;

function setRow(record) {
  if (!record) return null;
  return {
    ...record,
    id: toId(record.id),
    start_at: Number(record.start_at),
    versions: Number(record.versions),
    meta: parseJson(record.meta, {}),
  };
}

function itemRow(record) {
  return {
    ...record,
    item_id: toId(record.item_id),
    set_id: toId(record.set_id),
    problem_id: toId(record.problem_id),
    position: Number(record.position),
    seed: Number(record.seed),
    difficulty: Number(record.difficulty),
    params: parseJson(record.params, {}),
    tags: parseJson(record.tags, []),
  };
}

/** Items of a set whose ownership the caller has already established. */
function itemsOf(db, setId) {
  return db.prepare(ITEM_QUERY).all(Number(setId)).map(itemRow);
}

/** The set row, or null when it belongs to another workspace (or nowhere). */
function getBare(db, workspaceId, id) {
  return setRow(
    db.prepare('SELECT * FROM sets WHERE id = ? AND workspace_id = ?')
      .get(Number(id), requireWorkspace(workspaceId)),
  );
}

/** Which of `ids` are problems in this workspace. */
function ownedProblemIds(db, workspaceId, ids) {
  const clean = [...new Set(ids.map((id) => Number(id)).filter(Number.isFinite))];
  if (clean.length === 0) return new Set();
  const found = db
    .prepare(`SELECT id FROM problems
              WHERE workspace_id = ? AND id IN (${clean.map(() => '?').join(', ')})`)
    .all(requireWorkspace(workspaceId), ...clean);
  return new Set(found.map((record) => toId(record.id)));
}

function listItems(db, workspaceId, setId) {
  return getBare(db, workspaceId, setId) ? itemsOf(db, setId) : [];
}

function list(db, workspaceId, { limit = 100, offset = 0 } = {}) {
  const rows = db
    .prepare(`SELECT s.*, (SELECT COUNT(*) FROM set_items WHERE set_id = s.id) AS item_count
              FROM sets s WHERE s.workspace_id = ?
              ORDER BY s.updated_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(
      requireWorkspace(workspaceId),
      Math.min(Math.max(Number(limit) || 100, 1), 500),
      Math.max(Number(offset) || 0, 0),
    );
  return rows.map((record) => ({ ...setRow(record), item_count: toId(record.item_count) }));
}

/** A set plus its resolved items. */
function get(db, workspaceId, id) {
  const set = getBare(db, workspaceId, id);
  if (!set) return null;
  return { ...set, items: itemsOf(db, id) };
}

function toSetColumns(input, existing = {}) {
  const merged = { ...existing, ...input };
  const numbering = MODES.includes(merged.numbering) ? merged.numbering : 'sequential';
  const meta = merged.meta && typeof merged.meta === 'object' && !Array.isArray(merged.meta) ? merged.meta : {};
  return {
    title: String(merged.title ?? '').trim() || 'Untitled set',
    subject: String(merged.subject ?? '').trim(),
    numbering,
    start_at: Math.max(1, Math.round(Number(merged.start_at) || 1)),
    versions: Math.min(26, Math.max(1, Math.round(Number(merged.versions) || 1))),
    meta: JSON.stringify(meta),
  };
}

function create(db, workspaceId, input = {}) {
  const scope = requireWorkspace(workspaceId);
  const values = toSetColumns(input);
  const result = db
    .prepare(`INSERT INTO sets (workspace_id, title, subject, numbering, start_at, versions, meta)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(scope, values.title, values.subject, values.numbering, values.start_at,
      values.versions, values.meta);
  const id = toId(result.lastInsertRowid);
  if (Array.isArray(input.items) && input.items.length > 0) {
    replaceItems(db, scope, id, input.items);
  }
  return get(db, scope, id);
}

function update(db, workspaceId, id, input = {}) {
  const scope = requireWorkspace(workspaceId);
  const existing = getBare(db, scope, id);
  if (!existing) return null;
  const values = toSetColumns(input, existing);
  db.prepare(`UPDATE sets SET title = ?, subject = ?, numbering = ?, start_at = ?, versions = ?,
              meta = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(values.title, values.subject, values.numbering, values.start_at, values.versions,
      values.meta, Number(id), scope);
  if (Array.isArray(input.items)) replaceItems(db, scope, id, input.items);
  return get(db, scope, id);
}

function touch(db, id) {
  db.prepare("UPDATE sets SET updated_at = datetime('now') WHERE id = ?").run(Number(id));
}

function remove(db, workspaceId, id) {
  return db.prepare('DELETE FROM sets WHERE id = ? AND workspace_id = ?')
    .run(Number(id), requireWorkspace(workspaceId)).changes > 0;
}

function normaliseItem(item, index) {
  return {
    problem_id: Number(item.problem_id),
    position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
    seed: Number(item.seed) > 0 ? Math.floor(Number(item.seed)) : randomSeed(),
    label_override: String(item.label_override ?? '').trim(),
    override_statement: String(item.override_statement ?? '').trim(),
    override_answer: String(item.override_answer ?? '').trim(),
    override_solution: String(item.override_solution ?? '').trim(),
  };
}

/** Replace the whole item list, preserving explicitly supplied seeds. */
function replaceItems(db, workspaceId, setId, items) {
  const scope = requireWorkspace(workspaceId);
  if (!getBare(db, scope, setId)) return [];
  return transaction(db, () => {
    db.prepare('DELETE FROM set_items WHERE set_id = ?').run(Number(setId));
    const insert = db.prepare(`INSERT INTO set_items
      (set_id, problem_id, position, seed, label_override, override_statement, override_answer, override_solution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const normalised = items.map(normaliseItem).filter((item) => Number.isFinite(item.problem_id));
    const owned = ownedProblemIds(db, scope, normalised.map((item) => item.problem_id));
    normalised
      .filter((item) => owned.has(item.problem_id))
      .forEach((item, index) => {
        insert.run(Number(setId), item.problem_id, index, item.seed, item.label_override,
          item.override_statement, item.override_answer, item.override_solution);
      });
    touch(db, setId);
    return itemsOf(db, setId);
  });
}

/** Append problems to the end of a set. */
function addItems(db, workspaceId, setId, problemIds, seeds = {}) {
  const scope = requireWorkspace(workspaceId);
  if (!getBare(db, scope, setId)) return [];
  return transaction(db, () => {
    const next = toId(
      db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM set_items WHERE set_id = ?')
        .get(Number(setId)).next,
    );
    const insert = db.prepare(`INSERT INTO set_items (set_id, problem_id, position, seed)
                               VALUES (?, ?, ?, ?)`);
    const requested = problemIds.map((id) => Number(id)).filter(Number.isFinite);
    const owned = ownedProblemIds(db, scope, requested);
    requested
      .filter((problemId) => owned.has(problemId))
      .forEach((problemId, index) => {
        insert.run(Number(setId), problemId, next + index, Number(seeds[problemId]) || randomSeed());
      });
    touch(db, setId);
    return itemsOf(db, setId);
  });
}

function updateItem(db, workspaceId, setId, itemId, input = {}) {
  const scope = requireWorkspace(workspaceId);
  if (!getBare(db, scope, setId)) return [];
  const assignments = [];
  const params = [];
  for (const field of ['label_override', 'override_statement', 'override_answer', 'override_solution']) {
    if (field in input) {
      assignments.push(`${field} = ?`);
      params.push(String(input[field] ?? '').trim());
    }
  }
  if ('seed' in input) {
    assignments.push('seed = ?');
    params.push(Number(input.seed) > 0 ? Math.floor(Number(input.seed)) : randomSeed());
  }
  if (assignments.length === 0) return itemsOf(db, setId);
  db.prepare(`UPDATE set_items SET ${assignments.join(', ')} WHERE id = ? AND set_id = ?`)
    .run(...params, Number(itemId), Number(setId));
  touch(db, setId);
  return itemsOf(db, setId);
}

function removeItem(db, workspaceId, setId, itemId) {
  const scope = requireWorkspace(workspaceId);
  if (!getBare(db, scope, setId)) return [];
  db.prepare('DELETE FROM set_items WHERE id = ? AND set_id = ?').run(Number(itemId), Number(setId));
  touch(db, setId);
  return itemsOf(db, setId);
}

/** Move an item to a new index, renumbering the rest. */
function moveItem(db, workspaceId, setId, itemId, toIndex) {
  const scope = requireWorkspace(workspaceId);
  if (!getBare(db, scope, setId)) return [];
  return transaction(db, () => {
    const items = itemsOf(db, setId);
    const from = items.findIndex((item) => item.item_id === Number(itemId));
    if (from === -1) return items;
    const target = Math.min(Math.max(Number(toIndex) || 0, 0), items.length - 1);
    const [moved] = items.splice(from, 1);
    items.splice(target, 0, moved);
    const stmt = db.prepare('UPDATE set_items SET position = ? WHERE id = ?');
    items.forEach((item, index) => stmt.run(index, item.item_id));
    touch(db, setId);
    return itemsOf(db, setId);
  });
}

const SORT_KEYS = {
  section: (item) => [
    item.source_book || '',
    Number.parseFloat(item.source_section) || 0,
    item.source_section || '',
    Number.parseInt(item.source_number, 10) || 0,
  ],
  difficulty: (item) => [item.difficulty, item.topic || '', item.subtopic || ''],
  topic: (item) => [item.subject || '', item.topic || '', item.subtopic || '', item.difficulty],
};

/**
 * Reorder a set's items. The `section` ordering is what makes the
 * group-by-section numbering mode useful, since headings only appear where the
 * section actually changes.
 */
function sortItems(db, workspaceId, setId, by = 'section') {
  const scope = requireWorkspace(workspaceId);
  const keyFor = SORT_KEYS[by];
  if (!keyFor || !getBare(db, scope, setId)) return listItems(db, scope, setId);
  return transaction(db, () => {
    const items = itemsOf(db, setId);
    const ordered = items
      .map((item, index) => ({ item, key: keyFor(item), index }))
      .sort((a, b) => {
        for (let i = 0; i < Math.max(a.key.length, b.key.length); i += 1) {
          const left = a.key[i];
          const right = b.key[i];
          if (left === right) continue;
          if (typeof left === 'number' && typeof right === 'number') return left - right;
          return String(left).localeCompare(String(right));
        }
        return a.index - b.index; // Stable for ties.
      })
      .map((entry) => entry.item);
    const stmt = db.prepare('UPDATE set_items SET position = ? WHERE id = ?');
    ordered.forEach((item, index) => stmt.run(index, item.item_id));
    touch(db, setId);
    return itemsOf(db, setId);
  });
}

/** Give template-backed items fresh seeds, producing a new draw of the same set. */
function reseed(db, workspaceId, setId, { itemIds = null } = {}) {
  const scope = requireWorkspace(workspaceId);
  if (!getBare(db, scope, setId)) return [];
  return transaction(db, () => {
    const items = itemsOf(db, setId);
    const stmt = db.prepare('UPDATE set_items SET seed = ? WHERE id = ?');
    for (const item of items) {
      if (itemIds && !itemIds.map(Number).includes(item.item_id)) continue;
      if (item.kind !== 'template') continue;
      stmt.run(randomSeed(), item.item_id);
    }
    touch(db, setId);
    return itemsOf(db, setId);
  });
}

function duplicate(db, workspaceId, setId, title) {
  const scope = requireWorkspace(workspaceId);
  const source = get(db, scope, setId);
  if (!source) return null;
  return create(db, scope, {
    ...source,
    title: title || `${source.title} (copy)`,
    items: source.items,
  });
}

module.exports = {
  list, get, getBare, create, update, remove, listItems,
  replaceItems, addItems, updateItem, removeItem, moveItem, sortItems, reseed, duplicate,
  SORT_KEYS,
};
