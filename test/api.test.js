'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openMemory } = require('../server/db');
const { createApp } = require('../server/app');
const { seedAll } = require('../scripts/seed');

/**
 * The app is one question bank: everyone reads it, only the owner writes it.
 * These tests run the real stack against an in-memory database.
 */

/** A client with its own cookie jar, so each one is a separate visitor. */
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
      headers: response.headers,
      body: type.includes('json') ? await response.json() : await response.text(),
    };
  };
}

async function withServer({ multiUser = false, adminKey = 'test-owner-key' } = {}, run) {
  const db = openMemory();
  seedAll(db, { force: true });
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

test('the seed bank loads and every generated question works', async () => {
  await withServer({}, async ({ client }) => {
    const facets = await client('GET', '/api/problems/facets');
    assert.equal(facets.status, 200);
    assert.ok(facets.body.total > 40, 'a useful starter bank');
    assert.ok(facets.body.subjects.length >= 5);
    assert.ok(facets.body.tags.length > 20);

    // render=1 exercises the LaTeX -> HTML path on every question in the bank.
    const listed = await client('GET', '/api/problems?limit=500&render=1');
    assert.equal(listed.status, 200);
    const broken = listed.body.items.filter((problem) => problem.html.error);
    assert.deepEqual(broken.map((problem) => problem.topic), [], 'nothing fails to render');
    assert.ok(listed.body.items.every((problem) => problem.html.statement.length > 0));
    assert.ok(listed.body.items.some((problem) => problem.html.answer.length > 0),
      'answers are rendered too, for the reveal');
  });
});

test('filters and search narrow the bank', async () => {
  await withServer({}, async ({ client }) => {
    const all = await client('GET', '/api/problems?limit=1');
    const geometry = await client('GET', '/api/problems?subject=Geometry&limit=1');
    assert.ok(geometry.body.total > 0);
    assert.ok(geometry.body.total < all.body.total);

    const tagged = await client('GET', '/api/problems?tags=factoring&limit=100');
    assert.ok(tagged.body.items.length > 0);
    assert.ok(tagged.body.items.every((problem) => problem.tags.includes('factoring')));

    const hard = await client('GET', '/api/problems?difficulties=4,5&limit=100');
    assert.ok(hard.body.items.every((problem) => problem.difficulty >= 4));

    const generated = await client('GET', '/api/problems?kind=template&limit=100');
    assert.ok(generated.body.items.every((problem) => problem.kind === 'template'));

    assert.ok((await client('GET', '/api/problems?q=quadratic%20formula&limit=10')).body.total > 0);

    // Paging holds together.
    const first = await client('GET', '/api/problems?limit=10&offset=0&sort=topic');
    const second = await client('GET', '/api/problems?limit=10&offset=10&sort=topic');
    const overlap = first.body.items
      .map((p) => p.id)
      .filter((id) => second.body.items.some((p) => p.id === id));
    assert.deepEqual(overlap, [], 'pages do not repeat questions');
  });
});

test('a generated question can be re-rolled for new numbers', async () => {
  await withServer({}, async ({ client }) => {
    const templates = await client('GET', '/api/problems?kind=template&limit=1');
    const id = templates.body.items[0].id;

    const first = await client('GET', `/api/problems/${id}/preview?count=1&seed=101`);
    assert.equal(first.status, 200);
    assert.equal(first.body.instances[0].ok, true);
    assert.ok(first.body.instances[0].html.statement.length > 0);

    const same = await client('GET', `/api/problems/${id}/preview?count=1&seed=101`);
    assert.equal(same.body.instances[0].statement, first.body.instances[0].statement,
      'the same seed gives the same question');

    const different = await client('GET', `/api/problems/${id}/preview?count=1&seed=999`);
    assert.notEqual(different.body.instances[0].statement, first.body.instances[0].statement,
      'a new seed gives new numbers');

    // Every one of them is a valid question, not just the first.
    const many = await client('GET', `/api/problems/${id}/preview?count=8&seed=7`);
    assert.equal(many.body.instances.length, 8);
    assert.ok(many.body.instances.every((instance) => instance.ok));
  });
});

test('running locally, the bank is yours to edit', async () => {
  await withServer({ multiUser: false }, async ({ client }) => {
    const meta = await client('GET', '/api/meta');
    assert.equal(meta.body.multiUser, false);
    assert.equal(meta.body.canEditBank, true, 'no sign-in needed on your own machine');

    const created = await client('POST', '/api/problems', {
      subject: 'Trigonometry', topic: 'Identities', difficulty: 4, kind: 'template',
      statement: 'Simplify $\\sin^2\\theta + \\cos^2\\theta + {{a}}$.',
      answer: '${{a + 1}}$',
      params: { vars: { a: { type: 'int', min: 1, max: 5 } } },
      tags: ['Trig', 'identities', 'trig'],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.check.ok, true);
    assert.deepEqual(created.body.problem.tags, ['trig', 'identities'], 'tags normalised');

    const id = created.body.problem.id;
    const clamped = await client('PUT', `/api/problems/${id}`, {
      ...created.body.problem, difficulty: 9,
    });
    assert.equal(clamped.body.problem.difficulty, 5, 'difficulty is clamped to 1-5');

    // A template that cannot generate is still saved, but flagged.
    const broken = await client('PUT', `/api/problems/${id}`, {
      ...created.body.problem, statement: '{{missing}}',
    });
    assert.equal(broken.body.check.ok, false);
    assert.match(broken.body.check.error, /missing/);

    assert.equal((await client('POST', '/api/problems', { statement: '  ' })).status, 400);
    assert.equal((await client('DELETE', `/api/problems/${id}`)).status, 204);
    assert.equal((await client('GET', `/api/problems/${id}`)).status, 404);
  });
});

test('hosted, visitors can read everything and change nothing', async () => {
  await withServer({ multiUser: true }, async ({ newVisitor }) => {
    const student = newVisitor();

    const meta = await student('GET', '/api/meta');
    assert.equal(meta.body.canEditBank, false);
    assert.equal(meta.body.adminAvailable, true, 'the sign-in prompt can be offered');

    const existing = (await student('GET', '/api/problems?limit=1')).body.items[0];
    assert.ok(existing, 'reading works');

    const attempts = [
      ['POST', '/api/problems', { subject: 'X', topic: 'Y', statement: 'sneaked in' }],
      ['PUT', `/api/problems/${existing.id}`, { ...existing, statement: 'vandalised' }],
      ['DELETE', `/api/problems/${existing.id}`, undefined],
      ['POST', '/api/problems/import', { problems: [{ statement: 'bulk sneak' }] }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await student(method, path, body);
      assert.equal(response.status, 403, `${method} ${path} must be refused`);
      assert.match(response.body.error, /read-only/);
    }

    const after = await student('GET', `/api/problems/${existing.id}`);
    assert.equal(after.body.statement, existing.statement, 'nothing was altered');
    assert.equal((await student('GET', '/api/problems?q=sneak&limit=10')).body.total, 0);

    // Reading a question, including its answer, is the whole point.
    assert.ok(after.body.answer !== undefined);
    assert.equal((await student('GET', '/api/problems/export')).status, 200);
  });
});

test('the owner signs in, edits, and signs out again', async () => {
  await withServer({ multiUser: true, adminKey: 'correct-horse' }, async ({ newVisitor }) => {
    const owner = newVisitor();
    const student = newVisitor();

    assert.equal((await owner('GET', '/api/admin')).body.isAdmin, false, 'locked to begin with');
    assert.equal((await owner('POST', '/api/admin/unlock', { key: 'wrong' })).status, 401);

    const unlocked = await owner('POST', '/api/admin/unlock', { key: 'correct-horse' });
    assert.equal(unlocked.status, 200);
    assert.equal((await owner('GET', '/api/admin')).body.isAdmin, true, 'and it sticks');

    const added = await owner('POST', '/api/problems', {
      subject: 'Algebra 1', topic: 'Curated', difficulty: 2,
      statement: 'A question the owner wrote', answer: '$42$',
    });
    assert.equal(added.status, 201);

    // One bank, so a student sees it at once — and still cannot touch it.
    const seen = await student('GET', '/api/problems?q=owner+wrote&limit=5');
    assert.equal(seen.body.total, 1);
    assert.equal((await student('DELETE', `/api/problems/${added.body.problem.id}`)).status, 403);

    await owner('POST', '/api/admin/lock');
    assert.equal((await owner('GET', '/api/admin')).body.isAdmin, false);
    assert.equal((await owner('POST', '/api/problems', { statement: 'after lock' })).status, 403);
  });
});

test('with no owner key configured, nobody can edit', async () => {
  await withServer({ multiUser: true, adminKey: '' }, async ({ client }) => {
    const status = await client('GET', '/api/admin');
    assert.equal(status.body.available, false, 'the UI hides the prompt');
    assert.equal(status.body.isAdmin, false);
    assert.equal((await client('POST', '/api/admin/unlock', { key: 'anything' })).status, 503);
    assert.equal((await client('POST', '/api/problems', { statement: 'nope' })).status, 403);
  });
});

test('guessing the owner key is rate limited, and health is never blocked', async () => {
  await withServer({ multiUser: true, adminKey: 'secret' }, async ({ base }) => {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await fetch(`${base}/api/admin/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: `guess-${i}` }),
      });
      statuses.push(response.status);
    }
    assert.equal(statuses.filter((s) => s === 401).length, 10, 'ten guesses allowed');
    assert.equal(statuses.filter((s) => s === 429).length, 2, 'then refused');

    // The platform health check must survive a saturated limiter, or the host
    // will decide the service is unhealthy and restart it in a loop.
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/meta`)).status, 200);
  });
});

test('export round-trips back through import without duplicating', async () => {
  await withServer({}, async ({ client }) => {
    const before = (await client('GET', '/api/problems?limit=1')).body.total;
    const exported = await client('GET', '/api/problems/export');
    assert.equal(exported.body.problems.length, before);

    const reimported = await client('POST', '/api/problems/import', exported.body);
    assert.equal(reimported.body.updated, before);
    assert.equal(reimported.body.created, 0);
    assert.deepEqual(reimported.body.errors, []);
    assert.equal((await client('GET', '/api/problems?limit=1')).body.total, before);
  });
});

test('the worksheet endpoints are gone, not merely hidden', async () => {
  await withServer({}, async ({ client }) => {
    for (const path of ['/api/sets', '/api/templates', '/api/render/sets/1',
      '/print/1', '/download/1/tex', '/download/1/pdf', '/api/workspace']) {
      const response = await client('GET', path);
      assert.equal(response.status, 404, `${path} should not exist`);
    }
  });
});

test('the app serves its own front end', async () => {
  await withServer({}, async ({ client }) => {
    const page = await client('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /Question Bank/);
    assert.match(page.body, /js\/app\.js/);
    assert.equal((await client('GET', '/js/app.js')).status, 200);
    assert.equal((await client('GET', '/js/view-bank.js')).status, 200);
    assert.equal((await client('GET', '/css/app.css')).status, 200);
    assert.equal((await client('GET', '/vendor/katex/katex.min.css')).status, 200);
  });
});
