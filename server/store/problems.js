'use strict';

const { toId, parseJson } = require('../db');

const KINDS = ['static', 'template'];

const SORTS = {
  recent: 'updated_at DESC, id DESC',
  oldest: 'created_at ASC, id ASC',
  difficulty: 'difficulty ASC, subject ASC, topic ASC, id ASC',
  topic: 'subject ASC, topic ASC, subtopic ASC, difficulty ASC, id ASC',
  textbook: `source_book ASC,
             CAST(source_section AS REAL) ASC, source_section ASC,
             CAST(source_number AS INTEGER) ASC, source_number ASC, id ASC`,
};

const COLUMNS = [
  'subject', 'topic', 'subtopic', 'difficulty', 'kind', 'statement', 'answer', 'solution',
  'params', 'tags', 'source_book', 'source_edition', 'source_chapter', 'source_section',
  'source_number', 'notes', 'archived', 'external_key',
];

function clampDifficulty(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

function normaliseTags(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');
  const cleaned = list
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(cleaned)];
}

function row(record) {
  if (!record) return null;
  return {
    ...record,
    id: toId(record.id),
    difficulty: Number(record.difficulty),
    archived: Number(record.archived) === 1,
    params: parseJson(record.params, {}),
    tags: parseJson(record.tags, []),
  };
}

/** Build the column values for an insert/update from untrusted input. */
function toColumns(input, existing = {}) {
  const merged = { ...existing, ...input };
  const text = (key, fallback = '') => String(merged[key] ?? fallback).trim();
  return {
    subject: text('subject'),
    topic: text('topic'),
    subtopic: text('subtopic'),
    difficulty: clampDifficulty(merged.difficulty),
    kind: KINDS.includes(merged.kind) ? merged.kind : 'static',
    // Statements keep their internal whitespace; only the outer edges are trimmed.
    statement: String(merged.statement ?? '').trim(),
    answer: String(merged.answer ?? '').trim(),
    solution: String(merged.solution ?? '').trim(),
    params: JSON.stringify(
      merged.params && typeof merged.params === 'object' && !Array.isArray(merged.params) ? merged.params : {},
    ),
    tags: JSON.stringify(normaliseTags(merged.tags)),
    source_book: text('source_book'),
    source_edition: text('source_edition'),
    source_chapter: text('source_chapter'),
    source_section: text('source_section'),
    source_number: text('source_number'),
    notes: String(merged.notes ?? '').trim(),
    archived: merged.archived ? 1 : 0,
    external_key: merged.external_key ? String(merged.external_key).trim() : null,
  };
}

function buildFilter(filters = {}) {
  const clauses = [];
  const params = [];

  if (!filters.includeArchived) clauses.push('archived = 0');
  if (filters.archivedOnly) clauses.push('archived = 1');

  for (const [key, column] of [
    ['subject', 'subject'],
    ['topic', 'topic'],
    ['subtopic', 'subtopic'],
    ['book', 'source_book'],
    ['section', 'source_section'],
    ['chapter', 'source_chapter'],
  ]) {
    if (filters[key]) {
      clauses.push(`${column} = ?`);
      params.push(String(filters[key]));
    }
  }

  if (filters.kind && KINDS.includes(filters.kind)) {
    clauses.push('kind = ?');
    params.push(filters.kind);
  }

  const difficulties = Array.isArray(filters.difficulties)
    ? filters.difficulties.map(clampDifficulty)
    : [];
  if (difficulties.length > 0) {
    clauses.push(`difficulty IN (${difficulties.map(() => '?').join(', ')})`);
    params.push(...difficulties);
  } else {
    if (filters.difficultyMin != null && filters.difficultyMin !== '') {
      clauses.push('difficulty >= ?');
      params.push(clampDifficulty(filters.difficultyMin));
    }
    if (filters.difficultyMax != null && filters.difficultyMax !== '') {
      clauses.push('difficulty <= ?');
      params.push(clampDifficulty(filters.difficultyMax));
    }
  }

  for (const tag of normaliseTags(filters.tags || [])) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(problems.tags) WHERE json_each.value = ?)');
    params.push(tag);
  }

  if (filters.q) {
    const needle = `%${String(filters.q).trim()}%`;
    clauses.push(`(statement LIKE ? OR answer LIKE ? OR solution LIKE ? OR notes LIKE ?
                   OR topic LIKE ? OR subtopic LIKE ? OR source_number LIKE ?)`);
    params.push(needle, needle, needle, needle, needle, needle, needle);
  }

  if (filters.excludeIds && filters.excludeIds.length > 0) {
    const ids = filters.excludeIds.map((id) => Number(id)).filter(Number.isFinite);
    if (ids.length > 0) {
      clauses.push(`id NOT IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function list(db, filters = {}) {
  const { where, params } = buildFilter(filters);
  const order = SORTS[filters.sort] || SORTS.recent;
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const total = toId(
    db.prepare(`SELECT COUNT(*) AS n FROM problems ${where}`).get(...params).n,
  );
  const items = db
    .prepare(`SELECT * FROM problems ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map(row);

  return { items, total, limit, offset };
}

/** Every matching problem, unpaginated — used to build a pool for auto-select. */
function listAll(db, filters = {}) {
  const { where, params } = buildFilter(filters);
  const order = SORTS[filters.sort] || SORTS.textbook;
  return db.prepare(`SELECT * FROM problems ${where} ORDER BY ${order}`).all(...params).map(row);
}

function get(db, id) {
  return row(db.prepare('SELECT * FROM problems WHERE id = ?').get(Number(id)));
}

function getMany(db, ids) {
  const clean = ids.map((id) => Number(id)).filter(Number.isFinite);
  if (clean.length === 0) return [];
  const found = db
    .prepare(`SELECT * FROM problems WHERE id IN (${clean.map(() => '?').join(', ')})`)
    .all(...clean)
    .map(row);
  const byId = new Map(found.map((problem) => [problem.id, problem]));
  return clean.map((id) => byId.get(id)).filter(Boolean);
}

function create(db, input) {
  const values = toColumns(input);
  const result = db
    .prepare(`INSERT INTO problems (${COLUMNS.join(', ')})
              VALUES (${COLUMNS.map(() => '?').join(', ')})`)
    .run(...COLUMNS.map((column) => values[column]));
  return get(db, toId(result.lastInsertRowid));
}

function update(db, id, input) {
  const existing = get(db, id);
  if (!existing) return null;
  const values = toColumns(input, existing);
  db.prepare(`UPDATE problems SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')},
              updated_at = datetime('now') WHERE id = ?`)
    .run(...COLUMNS.map((column) => values[column]), Number(id));
  return get(db, id);
}

function remove(db, id) {
  return db.prepare('DELETE FROM problems WHERE id = ?').run(Number(id)).changes > 0;
}

/**
 * Insert, or update in place when `external_key` matches an existing row.
 * Seed files and JSON imports use this so re-importing is not destructive.
 */
function upsert(db, input) {
  const key = input.external_key ? String(input.external_key).trim() : null;
  if (key) {
    const existing = row(
      db.prepare('SELECT * FROM problems WHERE external_key = ?').get(key),
    );
    if (existing) return { problem: update(db, existing.id, input), created: false };
  }
  return { problem: create(db, input), created: true };
}

/** Distinct values powering the filter dropdowns. */
function facets(db) {
  const distinct = (column) => db
    .prepare(`SELECT DISTINCT ${column} AS value FROM problems
              WHERE archived = 0 AND ${column} <> '' ORDER BY ${column}`)
    .all()
    .map((record) => record.value);

  return {
    subjects: distinct('subject'),
    topics: db
      .prepare(`SELECT DISTINCT subject, topic FROM problems
                WHERE archived = 0 AND topic <> '' ORDER BY subject, topic`)
      .all(),
    subtopics: db
      .prepare(`SELECT DISTINCT topic, subtopic FROM problems
                WHERE archived = 0 AND subtopic <> '' ORDER BY topic, subtopic`)
      .all(),
    books: distinct('source_book'),
    sections: db
      .prepare(`SELECT DISTINCT source_book, source_section FROM problems
                WHERE archived = 0 AND source_section <> ''
                ORDER BY source_book, CAST(source_section AS REAL), source_section`)
      .all(),
    tags: db
      .prepare(`SELECT json_each.value AS value, COUNT(*) AS count
                FROM problems, json_each(problems.tags)
                WHERE archived = 0
                GROUP BY json_each.value ORDER BY count DESC, value ASC`)
      .all()
      .map((record) => ({ value: record.value, count: toId(record.count) })),
    counts: db
      .prepare(`SELECT difficulty, COUNT(*) AS count FROM problems
                WHERE archived = 0 GROUP BY difficulty ORDER BY difficulty`)
      .all()
      .map((record) => ({ difficulty: Number(record.difficulty), count: toId(record.count) })),
    total: toId(db.prepare('SELECT COUNT(*) AS n FROM problems WHERE archived = 0').get().n),
  };
}

module.exports = {
  list, listAll, get, getMany, create, update, remove, upsert, facets,
  normaliseTags, clampDifficulty, KINDS, SORTS,
};
