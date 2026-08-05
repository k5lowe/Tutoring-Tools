'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openMemory, DEFAULT_WORKSPACE_ID } = require('../server/db');
const { createApp } = require('../server/app');
const { seedAll } = require('../scripts/seed');

/**
 * Multi-user mode gives every visitor a private workspace. These tests exist to
 * prove one visitor cannot reach another's problems, sets or templates —
 * the one bug in this feature that would matter.
 */

/** A client that keeps its own cookie jar, so each one is a separate visitor. */
function visitor(base) {
  let cookie = null;
  const call = async (method, path, body) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
  call.rawCookie = () => cookie;
  return call;
}

async function withServer({ multiUser = true, seed = true, adminKey = 'test-owner-key' } = {}, run) {
  const db = openMemory();
  if (seed) seedAll(db, DEFAULT_WORKSPACE_ID, { force: true });
  const server = createApp(db, { multiUser, adminKey }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, db, newVisitor: () => visitor(base) });
  } finally {
    server.close();
    await new Promise((resolve) => server.once('close', resolve));
    db.close();
  }
}

test('single-user mode is unchanged: no cookies, one shared workspace', async () => {
  await withServer({ multiUser: false }, async ({ base }) => {
    const a = visitor(base);
    const info = await a('GET', '/api/workspace');
    assert.equal(info.body.multiUser, false);
    assert.equal(info.body.id, DEFAULT_WORKSPACE_ID);
    assert.equal(info.body.token, null);
    assert.equal(info.headers.get('set-cookie'), null, 'no cookie is issued locally');

    const created = await a('POST', '/api/problems', {
      subject: 'Local', topic: 'Only', statement: 'Local problem',
    });
    assert.equal(created.status, 201);

    // A different browser sees the same bank, which is what a local tool wants.
    const b = visitor(base);
    const found = await b('GET', `/api/problems/${created.body.problem.id}`);
    assert.equal(found.status, 200);
  });
});

test('each visitor gets their own workspace over one shared library', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const alice = newVisitor();
    const bob = newVisitor();

    const aliceInfo = await alice('GET', '/api/workspace');
    const bobInfo = await bob('GET', '/api/workspace');
    assert.equal(aliceInfo.body.multiUser, true);
    assert.notEqual(aliceInfo.body.id, bobInfo.body.id, 'different workspaces');
    assert.ok(aliceInfo.body.token);
    assert.notEqual(aliceInfo.body.token, bobInfo.body.token);

    const cookie = aliceInfo.headers.get('set-cookie');
    assert.match(cookie, /^tt_workspace=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    // The bank is one curated library, not a copy each: same problems, same ids.
    const aliceProblems = await alice('GET', '/api/problems?limit=500&sort=textbook');
    const bobProblems = await bob('GET', '/api/problems?limit=500&sort=textbook');
    assert.ok(aliceProblems.body.total > 40);
    assert.deepEqual(
      aliceProblems.body.items.map((p) => p.id),
      bobProblems.body.items.map((p) => p.id),
      'everyone reads exactly the same problems',
    );

    // Templates, though, are personal — they are part of how you print.
    const aliceIds = (await alice('GET', '/api/templates')).body.templates.map((t) => t.id);
    const bobIds = (await bob('GET', '/api/templates')).body.templates.map((t) => t.id);
    assert.ok(aliceIds.length >= 4);
    assert.equal(aliceIds.filter((id) => bobIds.includes(id)).length, 0, 'no shared template rows');
  });
});

test('visitors cannot change the library in any way', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const student = newVisitor();
    const existing = (await student('GET', '/api/problems?limit=1')).body.items[0];

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
    assert.equal(after.body.statement, existing.statement, 'the problem is untouched');
    assert.equal((await student('GET', '/api/problems?q=sneak&limit=10')).body.total, 0);
  });
});

test('the owner can edit the library, and everyone sees the change', async () => {
  await withServer({ adminKey: 'correct-horse' }, async ({ newVisitor }) => {
    const owner = newVisitor();
    const student = newVisitor();

    assert.equal((await owner('GET', '/api/admin')).body.isAdmin, false, 'locked to begin with');
    assert.equal((await owner('POST', '/api/admin/unlock', { key: 'wrong' })).status, 401);

    const unlocked = await owner('POST', '/api/admin/unlock', { key: 'correct-horse' });
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.body.isAdmin, true);
    assert.equal((await owner('GET', '/api/admin')).body.isAdmin, true, 'and it sticks');

    const added = await owner('POST', '/api/problems', {
      subject: 'Algebra 1', topic: 'Curated', difficulty: 2,
      statement: 'A problem the owner wrote', answer: '$42$',
    });
    assert.equal(added.status, 201);

    // A student who never signed in sees it at once, because it is one bank.
    const seen = await student('GET', '/api/problems?q=owner+wrote&limit=5');
    assert.equal(seen.body.total, 1);
    assert.equal(seen.body.items[0].id, added.body.problem.id);
    assert.equal((await student('DELETE', `/api/problems/${added.body.problem.id}`)).status, 403);

    // Signing out puts the bank back to read-only for the owner too.
    await owner('POST', '/api/admin/lock');
    assert.equal((await owner('GET', '/api/admin')).body.isAdmin, false);
    assert.equal((await owner('POST', '/api/problems', { statement: 'after lock' })).status, 403);
  });
});

test('with no owner key configured, the library cannot be edited at all', async () => {
  await withServer({ adminKey: '' }, async ({ newVisitor }) => {
    const someone = newVisitor();
    const status = await someone('GET', '/api/admin');
    assert.equal(status.body.available, false, 'the UI can hide the sign-in prompt');
    assert.equal(status.body.isAdmin, false);

    const tried = await someone('POST', '/api/admin/unlock', { key: 'anything' });
    assert.equal(tried.status, 503, 'there is nothing to unlock');
    assert.equal((await someone('POST', '/api/problems', { statement: 'nope' })).status, 403);
  });
});

test('sets, their documents and downloads are private too', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const alice = newVisitor();
    const bob = newVisitor();

    const generated = await alice('POST', '/api/sets/generate', {
      title: 'Alice homework', count: 4, filters: { subject: 'Geometry' },
    });
    assert.equal(generated.status, 201);
    const setId = generated.body.set.id;

    assert.equal((await bob('GET', '/api/sets')).body.sets.length, 0, 'not in their list');
    assert.equal((await bob('GET', `/api/sets/${setId}`)).status, 404);
    assert.equal((await bob('PUT', `/api/sets/${setId}`, { title: 'stolen' })).status, 404);
    assert.equal((await bob('DELETE', `/api/sets/${setId}`)).status, 404);
    assert.equal((await bob('POST', `/api/sets/${setId}/duplicate`, {})).status, 404);
    assert.equal((await bob('GET', `/api/render/sets/${setId}`)).status, 404, 'cannot render it');
    assert.equal((await bob('GET', `/print/${setId}`)).status, 404, 'cannot print it');
    assert.equal((await bob('GET', `/download/${setId}/tex`)).status, 404, 'cannot download it');

    // Alice is unaffected.
    assert.equal((await alice('GET', `/api/sets/${setId}`)).status, 200);
    assert.equal((await alice('GET', `/print/${setId}`)).status, 200);
  });
});

test('sets draw on the shared library, and reject ids that are not problems', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const tutor = newVisitor();
    const libraryProblem = (await tutor('GET', '/api/problems?limit=1')).body.items[0];

    const set = await tutor('POST', '/api/sets', { title: 'Hand picked' });
    const setId = set.body.set.id;

    // Any library problem is fair game — that is the point of the app.
    const added = await tutor('POST', `/api/sets/${setId}/items`, {
      problem_ids: [libraryProblem.id],
    });
    assert.equal(added.body.items.length, 1);
    assert.equal(added.body.items[0].problem_id, libraryProblem.id);

    // An id that is not a problem is still refused rather than stored.
    const bogus = await tutor('POST', `/api/sets/${setId}/items`, { problem_ids: [999999] });
    assert.equal(bogus.body.items.length, 1, 'nothing extra was added');
  });
});

test('template edits stay inside a workspace', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const alice = newVisitor();
    const bob = newVisitor();

    const aliceTemplates = (await alice('GET', '/api/templates?kind=practice')).body.templates;
    const bobTemplates = (await bob('GET', '/api/templates?kind=practice')).body.templates;
    const aliceTemplate = aliceTemplates[0];
    const bobTemplate = bobTemplates[0];

    await alice('PUT', `/api/templates/${aliceTemplate.id}`, {
      body: '\\documentclass{article}\\begin{document}ALICE ONLY\\end{document}',
    });

    assert.equal((await bob('GET', `/api/templates/${aliceTemplate.id}`)).status, 404);
    assert.equal((await bob('PUT', `/api/templates/${aliceTemplate.id}`, { body: 'x' })).status, 404);

    const bobBody = (await bob('GET', `/api/templates/${bobTemplate.id}`)).body.template.body;
    assert.ok(!bobBody.includes('ALICE ONLY'), "Bob's template is untouched");

    // And it really is Alice's template that renders her documents.
    const set = await alice('POST', '/api/sets/generate', { title: 'T', count: 2 });
    const rendered = await alice('GET', `/api/render/sets/${set.body.set.id}?kind=practice`);
    assert.match(rendered.body.latex, /ALICE ONLY/);

    const bobSet = await bob('POST', '/api/sets/generate', { title: 'T', count: 2 });
    const bobRendered = await bob('GET', `/api/render/sets/${bobSet.body.set.id}?kind=practice`);
    assert.doesNotMatch(bobRendered.body.latex, /ALICE ONLY/);
  });
});

test('a workspace can be restored on another device with its token link', async () => {
  await withServer({}, async ({ base, newVisitor }) => {
    const laptop = newVisitor();
    const info = await laptop('GET', '/api/workspace');
    const { token } = info.body;

    // Sets are what a tutor accumulates, so they are what has to travel.
    await laptop('POST', '/api/sets/generate', {
      title: 'Monday homework', count: 3, filters: { subject: 'Geometry' },
    });

    const phone = visitor(base);
    const restored = await phone('GET', `/api/workspace?w=${encodeURIComponent(token)}`);
    assert.equal(restored.body.id, info.body.id, 'same workspace');

    const sets = await phone('GET', '/api/sets');
    assert.equal(sets.body.sets.length, 1);
    assert.equal(sets.body.sets[0].title, 'Monday homework');

    assert.equal((await phone('GET', '/api/workspace')).body.id, info.body.id);
  });
});

test('a bogus or missing token quietly starts a fresh workspace', async () => {
  await withServer({}, async ({ base }) => {
    const stranger = visitor(base);
    const response = await stranger('GET', '/api/workspace?w=not-a-real-token');
    assert.equal(response.status, 200);
    assert.ok(response.body.id > 0);
    assert.notEqual(response.body.token, 'not-a-real-token', 'a real token is issued instead');

    // Injection attempts are treated as simply invalid, not as SQL.
    const nasty = visitor(base);
    const evil = await nasty(
      'GET',
      `/api/workspace?w=${encodeURIComponent("' OR 1=1 --")}`,
    );
    assert.equal(evil.status, 200);
    assert.ok(evil.body.id > 0);
    assert.equal((await nasty('GET', '/api/problems?q=Alice&limit=5')).body.total, 0);
  });
});

test('the library export is the same curated bank for everyone', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const alice = newVisitor();
    const bob = newVisitor();

    const aliceExport = await alice('GET', '/api/problems/export');
    const bobExport = await bob('GET', '/api/problems/export');
    assert.equal(aliceExport.status, 200);
    assert.deepEqual(
      aliceExport.body.problems.map((p) => p.external_key),
      bobExport.body.problems.map((p) => p.external_key),
      'one library, so one export',
    );

    // Exporting is reading; it does not become a way to write.
    assert.equal((await bob('POST', '/api/problems/import', bobExport.body)).status, 403);
  });
});

test('the workspace token is issued once and stays stable', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const visitorA = newVisitor();
    const first = await visitorA('GET', '/api/workspace');
    const second = await visitorA('GET', '/api/workspace');
    assert.equal(first.body.token, second.body.token, 'the same visitor keeps one token');
    assert.equal(first.body.id, second.body.id);

    // The cookie is refreshed on each response so its expiry rolls forward.
    assert.match(second.headers.get('set-cookie'), /Max-Age=\d+/);
  });
});

test('static files do not mint workspaces', async () => {
  await withServer({}, async ({ base, db }) => {
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n);

    // A crawler pulling assets with no cookie must not create a bank each time.
    for (const path of ['/', '/css/app.css', '/js/app.js', '/vendor/katex/katex.min.css']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
    }
    const after = Number(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n);
    assert.equal(after, before, 'no workspaces created by static requests');

    // A genuine visit does create exactly one.
    const alice = visitor(base);
    await alice('GET', '/api/workspace');
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n),
      before + 1,
    );
  });
});

test('workspace creation is rate limited per address', async () => {
  const db = openMemory();
  seedAll(db, DEFAULT_WORKSPACE_ID, { force: true });
  process.env.NEW_WORKSPACES_PER_HOUR = '3';
  const server = createApp(db, { multiUser: true }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      // A fresh visitor each time: no cookie, so each asks for a new workspace.
      const response = await fetch(`${base}/api/workspace`);
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429],
      'the first three succeed, the rest are refused');

    const blocked = await (await fetch(`${base}/api/workspace`)).json();
    assert.match(blocked.error, /Too many new workspaces/);
    assert.equal(blocked.token, undefined, 'a refused request hands out nothing');

    const created = db.prepare('SELECT id FROM workspaces WHERE token_hash IS NOT NULL').all();
    assert.equal(created.length, 3, 'the refused requests wrote nothing to the database');

    // The platform health check must survive a saturated limiter, or the host
    // will decide the service is unhealthy and restart it in a loop.
    assert.equal((await fetch(`${base}/api/health`)).status, 200, 'health check still passes');
    assert.equal((await fetch(`${base}/api/meta`)).status, 200, 'and so does config');
  } finally {
    delete process.env.NEW_WORKSPACES_PER_HOUR;
    server.close();
    await new Promise((resolve) => server.once('close', resolve));
    db.close();
  }
});

test('an existing workspace keeps working when the limiter is saturated', async () => {
  const db = openMemory();
  seedAll(db, DEFAULT_WORKSPACE_ID, { force: true });
  process.env.NEW_WORKSPACES_PER_HOUR = '1';
  const server = createApp(db, { multiUser: true }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const established = visitor(base);
    const mine = await established('GET', '/api/workspace');
    assert.equal(mine.status, 200);

    // Exhaust the allowance with anonymous callers.
    assert.equal((await fetch(`${base}/api/workspace`)).status, 429);

    // The visitor who already holds a cookie is unaffected.
    const still = await established('GET', '/api/problems?limit=1');
    assert.equal(still.status, 200);
    assert.ok(still.body.total > 40);
    const same = await established('GET', '/api/workspace');
    assert.equal(same.body.id, mine.body.id);
  } finally {
    delete process.env.NEW_WORKSPACES_PER_HOUR;
    server.close();
    await new Promise((resolve) => server.once('close', resolve));
    db.close();
  }
});

test('hosted mode refuses to run a LaTeX engine even when one is installed', async () => {
  // The risk is concrete: templates are user-written LaTeX, and an engine can
  // be told to \input a file off the host. Hosting must not depend on TeX
  // simply being absent from the image.
  const db = openMemory();
  seedAll(db, DEFAULT_WORKSPACE_ID, { force: true });
  const server = createApp(db, { multiUser: true }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const alice = visitor(base);
    const status = await alice('GET', '/api/render/pdf-status');
    assert.equal(status.body.available, false, 'reported unavailable regardless of the host');

    const meta = await alice('GET', '/api/meta');
    assert.equal(meta.body.pdf.available, false, 'so the UI never offers the button');

    const set = await alice('POST', '/api/sets/generate', { title: 'No pdf', count: 2 });
    const attempt = await alice('GET', `/download/${set.body.set.id}/pdf`);
    assert.equal(attempt.status, 501, 'and the endpoint refuses outright');
    assert.match(attempt.body.error, /switched off/);

    // The safe outputs are untouched.
    assert.equal((await alice('GET', `/download/${set.body.set.id}/tex`)).status, 200);
    assert.equal((await alice('GET', `/print/${set.body.set.id}`)).status, 200);
  } finally {
    server.close();
    await new Promise((resolve) => server.once('close', resolve));
    db.close();
  }
});

test('an operator can still opt into PDF building deliberately', async () => {
  const db = openMemory();
  seedAll(db, DEFAULT_WORKSPACE_ID, { force: true });
  const server = createApp(db, { multiUser: true, pdfEnabled: true }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const alice = visitor(base);
    const status = await alice('GET', '/api/render/pdf-status');
    // Whether it is actually available then depends on the host having TeX.
    assert.equal(typeof status.body.available, 'boolean');
    assert.ok(!('reason' in status.body), 'no longer reported as disabled by policy');
  } finally {
    server.close();
    await new Promise((resolve) => server.once('close', resolve));
    db.close();
  }
});

test('extra visitors do not multiply the problem rows', async () => {
  await withServer({}, async ({ newVisitor, db }) => {
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM problems').get().n);
    for (const who of [newVisitor(), newVisitor(), newVisitor()]) {
      const facets = await who('GET', '/api/problems/facets');
      assert.ok(facets.body.total > 40, 'every visitor sees the full library');
    }
    const after = Number(db.prepare('SELECT COUNT(*) AS n FROM problems').get().n);
    assert.equal(after, before, 'and not one problem row was copied');

    const keys = db.prepare(`SELECT COUNT(*) AS n FROM problems
                             WHERE external_key = 'alg1-two-step-linear'`).get();
    assert.equal(Number(keys.n), 1, 'exactly one row per problem, ever');
  });
});
