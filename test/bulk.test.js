'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openMemory } = require('../server/db');
const { createApp } = require('../server/app');

/**
 * Curating the bank in bulk, and taking an import back.
 *
 * Adding 150 questions takes one paste, so fixing 150 questions has to take one
 * action too. These run the real stack against an empty in-memory bank — no
 * seed data, so every count here is exactly what the test put there.
 */

function visitor(base) {
  let cookie = null;
  return async (method, path, body) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const issued = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const value of issued) cookie = value.split(';')[0];
    const type = response.headers.get('content-type') || '';
    return {
      status: response.status,
      body: type.includes('json') ? await response.json() : await response.text(),
    };
  };
}

async function withBank({ multiUser = false, adminKey = 'key' } = {}, run) {
  const db = openMemory();
  const server = createApp(db, { multiUser, adminKey }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, db, client: visitor(base), newVisitor: () => visitor(base) });
  } finally {
    server.close();
    await new Promise((resolve) => server.once('close', resolve));
    db.close();
  }
}

/** A batch in the plain-text format, all under one `@` line. */
function batch(count, context, prefix = 'Question') {
  return [`@ ${context}`]
    .concat(Array.from({ length: count }, (unused, i) => `---\nQ: ${prefix} ${i + 1}\nA: $${i + 1}$`))
    .join('\n');
}

async function importText(client, text) {
  const checked = await client('POST', '/api/problems/parse', { text });
  assert.deepEqual(checked.body.errors, [], 'the fixture itself must parse');
  return client('POST', '/api/problems/import', { problems: checked.body.questions });
}

test('a whole batch is re-filed in one action', async () => {
  await withBank({}, async ({ client }) => {
    await importText(client, batch(150, 'Algebra 2 > Quadratics | d3 | tags: drill'));
    await importText(client, batch(10, 'Geometry > Circles | d2 | tags: drill', 'Circle'));

    const filters = { subject: 'Algebra 2', topic: 'Quadratics' };
    assert.equal((await client('GET', '/api/problems?subject=Algebra+2&topic=Quadratics&limit=1'))
      .body.total, 150);

    const changed = await client('POST', '/api/problems/bulk', {
      filters,
      expect: 150,
      changes: { topic: 'Quadratic Equations', difficulty: 2, addTags: ['practice'], removeTags: ['drill'] },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.matched, 150);
    assert.equal(changed.body.updated, 150);

    const moved = await client('GET', '/api/problems?topic=Quadratic+Equations&limit=500');
    assert.equal(moved.body.total, 150);
    assert.ok(moved.body.items.every((p) => p.difficulty === 2), 'difficulty came along');
    assert.ok(moved.body.items.every((p) => p.tags.includes('practice')), 'tag added');
    assert.ok(moved.body.items.every((p) => !p.tags.includes('drill')), 'tag removed');
    assert.ok(moved.body.items.every((p) => p.subject === 'Algebra 2'), 'subject untouched');
    assert.ok(moved.body.items.every((p) => p.statement.startsWith('Question')), 'the maths is untouched');

    // The questions outside the filter are exactly as they were.
    const geometry = await client('GET', '/api/problems?subject=Geometry&limit=50');
    assert.equal(geometry.body.total, 10);
    assert.ok(geometry.body.items.every((p) => p.topic === 'Circles'));
    assert.ok(geometry.body.items.every((p) => p.difficulty === 2));
    assert.ok(geometry.body.items.every((p) => p.tags.includes('drill')),
      'a bulk retag stops at the edge of the filter');
  });
});

test('a bulk change touches only the fields it was given', async () => {
  await withBank({}, async ({ client }) => {
    await importText(client, batch(3, 'Algebra 1 > Slope > Point-slope | d4 | tags: graphing, drill'));

    const before = (await client('GET', '/api/problems?limit=10')).body.items;
    await client('POST', '/api/problems/bulk', {
      filters: { subject: 'Algebra 1' },
      changes: { subject: 'Algebra I' },
    });
    const after = (await client('GET', '/api/problems?limit=10')).body.items;

    assert.ok(after.every((p) => p.subject === 'Algebra I'));
    for (const field of ['topic', 'subtopic', 'difficulty', 'statement', 'answer', 'kind']) {
      assert.deepEqual(after.map((p) => p[field]), before.map((p) => p[field]), field);
    }
    assert.deepEqual(after[0].tags, before[0].tags, 'tags survive a change that never mentions them');
  });
});

test('a blank field means leave it alone, not blank it out', async () => {
  await withBank({}, async ({ client }) => {
    await importText(client, batch(2, 'Precalculus > Vectors > Dot product | d3'));

    const changed = await client('POST', '/api/problems/bulk', {
      filters: {},
      changes: { subject: '', topic: '   ', subtopic: null, difficulty: 5 },
    });
    assert.equal(changed.body.updated, 2);

    const items = (await client('GET', '/api/problems?limit=10')).body.items;
    assert.ok(items.every((p) => p.subject === 'Precalculus'), 'empty string did not wipe the subject');
    assert.ok(items.every((p) => p.topic === 'Vectors'));
    assert.ok(items.every((p) => p.subtopic === 'Dot product'));
    assert.ok(items.every((p) => p.difficulty === 5), 'the one real change landed');
  });
});

test('a change that changes nothing reports as much instead of churning rows', async () => {
  await withBank({}, async ({ client }) => {
    await importText(client, batch(4, 'Calculus 1 > Limits | d3'));
    const result = await client('POST', '/api/problems/bulk', {
      filters: {}, changes: { subject: '', addTags: [], removeTags: [] },
    });
    assert.equal(result.body.matched, 4);
    assert.equal(result.body.updated, 0);
  });
});

test('a bulk change is refused when the filter no longer matches what was counted', async () => {
  await withBank({}, async ({ client }) => {
    await importText(client, batch(5, 'Geometry > Triangles | d2'));

    const stale = await client('POST', '/api/problems/bulk', {
      filters: { subject: 'Geometry' },
      expect: 40,
      changes: { difficulty: 5 },
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /matched 40 .* matches 5 now/);
    assert.equal(stale.body.matched, 5);

    const items = (await client('GET', '/api/problems?limit=10')).body.items;
    assert.ok(items.every((p) => p.difficulty === 2), 'and nothing was changed');
  });
});

test('deleting a batch needs the number you were shown', async () => {
  await withBank({}, async ({ client }) => {
    await importText(client, batch(30, 'Algebra 2 > Logarithms | d3'));
    await importText(client, batch(6, 'Geometry > Circles | d1', 'Circle'));

    const noCount = await client('POST', '/api/problems/bulk-delete', {
      filters: { subject: 'Algebra 2' },
    });
    assert.equal(noCount.status, 400, 'a bare delete-everything is not accepted');
    assert.match(noCount.body.error, /number of questions you expect/);

    const wrongCount = await client('POST', '/api/problems/bulk-delete', {
      filters: { subject: 'Algebra 2' }, expect: 29,
    });
    assert.equal(wrongCount.status, 409);
    assert.equal((await client('GET', '/api/problems?limit=1')).body.total, 36,
      'a refused delete deletes nothing');

    const done = await client('POST', '/api/problems/bulk-delete', {
      filters: { subject: 'Algebra 2' }, expect: 30,
    });
    assert.equal(done.body.deleted, 30);
    assert.equal((await client('GET', '/api/problems?limit=1')).body.total, 6,
      'the other subject is untouched');
  });
});

test('an import can be taken back, and takes back exactly what it added', async () => {
  await withBank({}, async ({ client }) => {
    // A good batch, then one misfiled by a typo in its "@" line.
    await importText(client, batch(20, 'Algebra 2 > Quadratics | d3', 'Keeper'));
    const oops = await importText(client, batch(50, 'Algebra 2 > Quadratics | d3', 'Misfiled'));

    assert.ok(oops.body.importId, 'the import says which batch it was');
    assert.equal((await client('GET', '/api/problems?limit=1')).body.total, 70);

    const history = await client('GET', '/api/imports');
    assert.equal(history.body.imports.length, 2);
    assert.equal(history.body.last.id, oops.body.importId, 'the newest is offered for undo');
    assert.equal(history.body.last.created, 50);

    const undone = await client('POST', `/api/imports/${oops.body.importId}/undo`);
    assert.equal(undone.status, 200);
    assert.equal(undone.body.removed, 50);

    const left = await client('GET', '/api/problems?limit=100');
    assert.equal(left.body.total, 20, 'only the bad batch went');
    assert.ok(left.body.items.every((p) => p.statement.startsWith('Keeper')),
      'the batch written last month is still there');

    // Undoing is not something to do twice.
    const again = await client('POST', `/api/imports/${oops.body.importId}/undo`);
    assert.equal(again.status, 409);

    // Undo walks backwards: with the newest taken back, the one before it is
    // what "undo the last import" now means.
    const next = (await client('GET', '/api/imports')).body.last;
    assert.equal(next.created, 20);
    assert.notEqual(next.id, oops.body.importId);

    await client('POST', `/api/imports/${next.id}/undo`);
    assert.equal((await client('GET', '/api/problems?limit=1')).body.total, 0);
    assert.equal((await client('GET', '/api/imports')).body.last, null,
      'nothing is offered for undo once everything has been');
  });
});

test('undoing a re-import puts the overwritten questions back as they were', async () => {
  await withBank({}, async ({ client }) => {
    const original = `
@ Algebra 1 > Factoring | d2 | tags: factoring
Q: Factor completely: $x^2 - 5x - 14$
A: $(x-7)(x+2)$
S: Product $-14$, sum $-5$.
K: keyed-question
`;
    await importText(client, original);
    const before = (await client('GET', '/api/problems?limit=1')).body.items[0];

    // The same key, imported again with different content and different filing.
    const revised = `
@ Geometry > Circles | d5 | tags: circles
Q: Something else entirely
A: $0$
K: keyed-question
`;
    const second = await importText(client, revised);
    assert.equal(second.body.updated, 1);
    assert.equal(second.body.created, 0, 'matched on the key rather than duplicated');

    const changed = (await client('GET', '/api/problems?limit=1')).body.items[0];
    assert.equal(changed.id, before.id, 'the same row');
    assert.equal(changed.statement, 'Something else entirely');
    assert.equal(changed.subject, 'Geometry');

    const undone = await client('POST', `/api/imports/${second.body.importId}/undo`);
    assert.equal(undone.body.restored, 1);
    assert.equal(undone.body.removed, 0);

    const restored = (await client('GET', '/api/problems?limit=1')).body.items[0];
    assert.equal(restored.id, before.id);
    for (const field of ['statement', 'answer', 'solution', 'subject', 'topic',
      'difficulty', 'kind', 'external_key', 'source_book']) {
      assert.deepEqual(restored[field], before[field], field);
    }
    assert.deepEqual(restored.tags, before.tags);
    assert.deepEqual(restored.params, before.params);
    assert.equal((await client('GET', '/api/problems?limit=1')).body.total, 1,
      'no stray row was created by the restore');
  });
});

test('undo survives questions deleted by hand in the meantime', async () => {
  await withBank({}, async ({ client }) => {
    const imported = await importText(client, batch(5, 'Geometry > Angles | d1'));
    const items = (await client('GET', '/api/problems?limit=10')).body.items;
    assert.equal((await client('DELETE', `/api/problems/${items[0].id}`)).status, 204);

    const undone = await client('POST', `/api/imports/${imported.body.importId}/undo`);
    assert.equal(undone.status, 200);
    assert.equal(undone.body.removed, 4, 'the four still there went; the missing one is not an error');
    assert.equal((await client('GET', '/api/problems?limit=1')).body.total, 0);
  });
});

test('an import that saves nothing leaves no undo entry to click', async () => {
  await withBank({}, async ({ client }) => {
    const empty = await client('POST', '/api/problems/import', { problems: [] });
    assert.equal(empty.body.created, 0);
    assert.equal(empty.body.importId, null);
    assert.deepEqual((await client('GET', '/api/imports')).body.imports, []);
  });
});

test('visitors cannot curate, delete in bulk, or see the import history', async () => {
  await withBank({ multiUser: true, adminKey: 'correct-horse' }, async ({ newVisitor }) => {
    const owner = newVisitor();
    await owner('POST', '/api/admin/unlock', { key: 'correct-horse' });
    const imported = await importText(owner, batch(3, 'Algebra 1 > Factoring | d2'));

    const student = newVisitor();
    const attempts = [
      ['POST', '/api/problems/bulk', { filters: {}, changes: { subject: 'Vandalised' } }],
      ['POST', '/api/problems/bulk-delete', { filters: {}, expect: 3 }],
      ['GET', '/api/imports', undefined],
      ['POST', `/api/imports/${imported.body.importId}/undo`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      const response = await student(method, path, body);
      assert.equal(response.status, 403, `${method} ${path} must be refused`);
      assert.match(response.body.error, /read-only/);
    }

    const after = await student('GET', '/api/problems?limit=10');
    assert.equal(after.body.total, 3);
    assert.ok(after.body.items.every((p) => p.subject === 'Algebra 1'), 'nothing was touched');
  });
});
