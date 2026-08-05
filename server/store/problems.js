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

function requireWorkspace(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(`a workspace id is required, got ${JSON.stringify(workspaceId)}`);
  }
  return id;
}

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

/**
 * Every query starts scoped to one workspace. `workspaceId` is a required
 * argument throughout this module rather than an option with a default, so a
 * call site that forgets it fails loudly instead of quietly reading someone
 * else's bank.
 */
function buildFilter(workspaceId, filters = {}) {
  const clauses = ['workspace_id = ?'];
  const params = [requireWorkspace(workspaceId)];

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

  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

function list(db, workspaceId, filters = {}) {
  const { where, params } = buildFilter(workspaceId, filters);
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
function listAll(db, workspaceId, filters = {}) {
  const { where, params } = buildFilter(workspaceId, filters);
  const order = SORTS[filters.sort] || SORTS.textbook;
  return db.prepare(`SELECT * FROM problems ${where} ORDER BY ${order}`).all(...params).map(row);
}

function get(db, workspaceId, id) {
  return row(
    db.prepare('SELECT * FROM problems WHERE id = ? AND workspace_id = ?')
      .get(Number(id), requireWorkspace(workspaceId)),
  );
}

function getMany(db, workspaceId, ids) {
  const scope = requireWorkspace(workspaceId);
  const clean = ids.map((id) => Number(id)).filter(Number.isFinite);
  if (clean.length === 0) return [];
  const found = db
    .prepare(`SELECT * FROM problems
              WHERE workspace_id = ? AND id IN (${clean.map(() => '?').join(', ')})`)
    .all(scope, ...clean)
    .map(row);
  const byId = new Map(found.map((problem) => [problem.id, problem]));
  return clean.map((id) => byId.get(id)).filter(Boolean);
}

function create(db, workspaceId, input) {
  const scope = requireWorkspace(workspaceId);
  const values = toColumns(input);
  const columns = ['workspace_id', ...COLUMNS];
  const result = db
    .prepare(`INSERT INTO problems (${columns.join(', ')})
              VALUES (${columns.map(() => '?').join(', ')})`)
    .run(scope, ...COLUMNS.map((column) => values[column]));
  return get(db, scope, toId(result.lastInsertRowid));
}

function update(db, workspaceId, id, input) {
  const scope = requireWorkspace(workspaceId);
  const existing = get(db, scope, id);
  if (!existing) return null;
  const values = toColumns(input, existing);
  db.prepare(`UPDATE problems SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')},
              updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(...COLUMNS.map((column) => values[column]), Number(id), scope);
  return get(db, scope, id);
}

function remove(db, workspaceId, id) {
  return db.prepare('DELETE FROM problems WHERE id = ? AND workspace_id = ?')
    .run(Number(id), requireWorkspace(workspaceId)).changes > 0;
}

/**
 * Insert, or update in place when `external_key` matches an existing row.
 * Seed files and JSON imports use this so re-importing is not destructive.
 */
function upsert(db, workspaceId, input) {
  const scope = requireWorkspace(workspaceId);
  const key = input.external_key ? String(input.external_key).trim() : null;
  if (key) {
    const existing = row(
      db.prepare('SELECT * FROM problems WHERE workspace_id = ? AND external_key = ?').get(scope, key),
    );
    if (existing) return { problem: update(db, scope, existing.id, input), created: false };
  }
  return { problem: create(db, scope, input), created: true };
}

/** Distinct values powering the filter dropdowns. */
function facets(db, workspaceId) {
  const scope = requireWorkspace(workspaceId);
  const distinct = (column) => db
    .prepare(`SELECT DISTINCT ${column} AS value FROM problems
              WHERE workspace_id = ? AND archived = 0 AND ${column} <> '' ORDER BY ${column}`)
    .all(scope)
    .map((record) => record.value);

  return {
    subjects: distinct('subject'),
    topics: db
      .prepare(`SELECT DISTINCT subject, topic FROM problems
                WHERE workspace_id = ? AND archived = 0 AND topic <> '' ORDER BY subject, topic`)
      .all(scope),
    subtopics: db
      .prepare(`SELECT DISTINCT topic, subtopic FROM problems
                WHERE workspace_id = ? AND archived = 0 AND subtopic <> '' ORDER BY topic, subtopic`)
      .all(scope),
    books: distinct('source_book'),
    sections: db
      .prepare(`SELECT DISTINCT source_book, source_section FROM problems
                WHERE workspace_id = ? AND archived = 0 AND source_section <> ''
                ORDER BY source_book, CAST(source_section AS REAL), source_section`)
      .all(scope),
    tags: db
      .prepare(`SELECT json_each.value AS value, COUNT(*) AS count
                FROM problems, json_each(problems.tags)
                WHERE problems.workspace_id = ? AND archived = 0
                GROUP BY json_each.value ORDER BY count DESC, value ASC`)
      .all(scope)
      .map((record) => ({ value: record.value, count: toId(record.count) })),
    counts: db
      .prepare(`SELECT difficulty, COUNT(*) AS count FROM problems
                WHERE workspace_id = ? AND archived = 0 GROUP BY difficulty ORDER BY difficulty`)
      .all(scope)
      .map((record) => ({ difficulty: Number(record.difficulty), count: toId(record.count) })),
    total: toId(
      db.prepare('SELECT COUNT(*) AS n FROM problems WHERE workspace_id = ? AND archived = 0')
        .get(scope).n,
    ),
  };
}

module.exports = {
  list, listAll, get, getMany, create, update, remove, upsert, facets,
  normaliseTags, clampDifficulty, requireWorkspace, KINDS, SORTS,
};
