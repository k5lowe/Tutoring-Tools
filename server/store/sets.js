'use strict';

const { toId, parseJson, transaction } = require('../db');
const { randomSeed } = require('../lib/rng');
const { MODES } = require('../lib/numbering');

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

function listItems(db, setId) {
  return db.prepare(ITEM_QUERY).all(Number(setId)).map(itemRow);
}

function list(db, { limit = 100, offset = 0 } = {}) {
  const rows = db
    .prepare(`SELECT s.*, (SELECT COUNT(*) FROM set_items WHERE set_id = s.id) AS item_count
              FROM sets s ORDER BY s.updated_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(Math.min(Math.max(Number(limit) || 100, 1), 500), Math.max(Number(offset) || 0, 0));
  return rows.map((record) => ({ ...setRow(record), item_count: toId(record.item_count) }));
}

function getBare(db, id) {
  return setRow(db.prepare('SELECT * FROM sets WHERE id = ?').get(Number(id)));
}

/** A set plus its resolved items. */
function get(db, id) {
  const set = getBare(db, id);
  if (!set) return null;
  return { ...set, items: listItems(db, id) };
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

function create(db, input = {}) {
  const values = toSetColumns(input);
  const result = db
    .prepare(`INSERT INTO sets (title, subject, numbering, start_at, versions, meta)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(values.title, values.subject, values.numbering, values.start_at, values.versions, values.meta);
  const id = toId(result.lastInsertRowid);
  if (Array.isArray(input.items) && input.items.length > 0) {
    replaceItems(db, id, input.items);
  }
  return get(db, id);
}

function update(db, id, input = {}) {
  const existing = getBare(db, id);
  if (!existing) return null;
  const values = toSetColumns(input, existing);
  db.prepare(`UPDATE sets SET title = ?, subject = ?, numbering = ?, start_at = ?, versions = ?,
              meta = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(values.title, values.subject, values.numbering, values.start_at, values.versions,
      values.meta, Number(id));
  if (Array.isArray(input.items)) replaceItems(db, id, input.items);
  return get(db, id);
}

function touch(db, id) {
  db.prepare("UPDATE sets SET updated_at = datetime('now') WHERE id = ?").run(Number(id));
}

function remove(db, id) {
  return db.prepare('DELETE FROM sets WHERE id = ?').run(Number(id)).changes > 0;
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
function replaceItems(db, setId, items) {
  return transaction(db, () => {
    db.prepare('DELETE FROM set_items WHERE set_id = ?').run(Number(setId));
    const insert = db.prepare(`INSERT INTO set_items
      (set_id, problem_id, position, seed, label_override, override_statement, override_answer, override_solution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    items
      .map(normaliseItem)
      .filter((item) => Number.isFinite(item.problem_id))
      .forEach((item, index) => {
        insert.run(Number(setId), item.problem_id, index, item.seed, item.label_override,
          item.override_statement, item.override_answer, item.override_solution);
      });
    touch(db, setId);
    return listItems(db, setId);
  });
}

/** Append problems to the end of a set. */
function addItems(db, setId, problemIds, seeds = {}) {
  return transaction(db, () => {
    const next = toId(
      db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM set_items WHERE set_id = ?')
        .get(Number(setId)).next,
    );
    const insert = db.prepare(`INSERT INTO set_items (set_id, problem_id, position, seed)
                               VALUES (?, ?, ?, ?)`);
    problemIds
      .map((id) => Number(id))
      .filter(Number.isFinite)
      .forEach((problemId, index) => {
        insert.run(Number(setId), problemId, next + index, Number(seeds[problemId]) || randomSeed());
      });
    touch(db, setId);
    return listItems(db, setId);
  });
}

function updateItem(db, setId, itemId, input = {}) {
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
  if (assignments.length === 0) return listItems(db, setId);
  db.prepare(`UPDATE set_items SET ${assignments.join(', ')} WHERE id = ? AND set_id = ?`)
    .run(...params, Number(itemId), Number(setId));
  touch(db, setId);
  return listItems(db, setId);
}

function removeItem(db, setId, itemId) {
  db.prepare('DELETE FROM set_items WHERE id = ? AND set_id = ?').run(Number(itemId), Number(setId));
  touch(db, setId);
  return listItems(db, setId);
}

/** Move an item to a new index, renumbering the rest. */
function moveItem(db, setId, itemId, toIndex) {
  return transaction(db, () => {
    const items = listItems(db, setId);
    const from = items.findIndex((item) => item.item_id === Number(itemId));
    if (from === -1) return items;
    const target = Math.min(Math.max(Number(toIndex) || 0, 0), items.length - 1);
    const [moved] = items.splice(from, 1);
    items.splice(target, 0, moved);
    const stmt = db.prepare('UPDATE set_items SET position = ? WHERE id = ?');
    items.forEach((item, index) => stmt.run(index, item.item_id));
    touch(db, setId);
    return listItems(db, setId);
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
function sortItems(db, setId, by = 'section') {
  const keyFor = SORT_KEYS[by];
  if (!keyFor) return listItems(db, setId);
  return transaction(db, () => {
    const items = listItems(db, setId);
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
    return listItems(db, setId);
  });
}

/** Give template-backed items fresh seeds, producing a new draw of the same set. */
function reseed(db, setId, { itemIds = null } = {}) {
  return transaction(db, () => {
    const items = listItems(db, setId);
    const stmt = db.prepare('UPDATE set_items SET seed = ? WHERE id = ?');
    for (const item of items) {
      if (itemIds && !itemIds.map(Number).includes(item.item_id)) continue;
      if (item.kind !== 'template') continue;
      stmt.run(randomSeed(), item.item_id);
    }
    touch(db, setId);
    return listItems(db, setId);
  });
}

function duplicate(db, setId, title) {
  const source = get(db, setId);
  if (!source) return null;
  return create(db, {
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
