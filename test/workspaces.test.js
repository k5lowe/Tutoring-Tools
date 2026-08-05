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

async function withServer({ multiUser = true, seed = true } = {}, run) {
  const db = openMemory();
  if (seed) seedAll(db, DEFAULT_WORKSPACE_ID, { force: true });
  const server = createApp(db, { multiUser }).listen(0, '127.0.0.1');
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

test('each visitor gets their own workspace, seeded and separate', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const alice = newVisitor();
    const bob = newVisitor();

    const aliceInfo = await alice('GET', '/api/workspace');
    const bobInfo = await bob('GET', '/api/workspace');
    assert.equal(aliceInfo.body.multiUser, true);
    assert.notEqual(aliceInfo.body.id, bobInfo.body.id, 'different workspaces');
    assert.ok(aliceInfo.body.token, 'a token is returned so the UI can offer a link');
    assert.notEqual(aliceInfo.body.token, bobInfo.body.token);

    const cookie = aliceInfo.headers.get('set-cookie');
    assert.match(cookie, /^tt_workspace=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);

    // Both start from the same starter bank rather than an empty one.
    const aliceFacets = await alice('GET', '/api/problems/facets');
    const bobFacets = await bob('GET', '/api/problems/facets');
    assert.ok(aliceFacets.body.total > 40);
    assert.equal(aliceFacets.body.total, bobFacets.body.total);

    // And their own copy of the shipped templates.
    const aliceTemplates = await alice('GET', '/api/templates');
    assert.ok(aliceTemplates.body.templates.length >= 4);
    const bobTemplates = await bob('GET', '/api/templates');
    const aliceIds = aliceTemplates.body.templates.map((t) => t.id);
    const bobIds = bobTemplates.body.templates.map((t) => t.id);
    assert.equal(aliceIds.filter((id) => bobIds.includes(id)).length, 0, 'no shared template rows');
  });
});

test('one visitor cannot read, change or delete another visitor\'s problems', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const alice = newVisitor();
    const bob = newVisitor();

    const secret = await alice('POST', '/api/problems', {
      subject: 'Private', topic: 'Secret', statement: "Alice's private problem",
      tags: ['confidential'],
    });
    assert.equal(secret.status, 201);
    const id = secret.body.problem.id;

    assert.equal((await bob('GET', `/api/problems/${id}`)).status, 404, 'cannot read it');
    assert.equal((await bob('PUT', `/api/problems/${id}`, { statement: 'hijacked' })).status, 404,
      'cannot overwrite it');
    assert.equal((await bob('DELETE', `/api/problems/${id}`)).status, 404, 'cannot delete it');

    const bobSearch = await bob('GET', '/api/problems?q=private&limit=50');
    assert.equal(bobSearch.body.total, 0, 'it does not turn up in search');

    const bobTags = await bob('GET', '/api/problems/facets');
    assert.ok(!bobTags.body.tags.some((tag) => tag.value === 'confidential'),
      'and does not leak through the tag list');

    // Alice still has it, unmodified.
    const mine = await alice('GET', `/api/problems/${id}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.statement, "Alice's private problem");
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

test('a set cannot be made to reference another workspace\'s problem', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const alice = newVisitor();
    const bob = newVisitor();

    const aliceProblem = await alice('POST', '/api/problems', {
      subject: 'Private', topic: 'Secret', statement: 'Alice only',
    });
    const aliceProblemId = aliceProblem.body.problem.id;

    const bobSet = await bob('POST', '/api/sets', { title: 'Bob set' });
    const bobSetId = bobSet.body.set.id;

    // Guessing an id from another workspace must not pull the problem in.
    const added = await bob('POST', `/api/sets/${bobSetId}/items`, {
      problem_ids: [aliceProblemId],
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.items.length, 0, 'the foreign problem is refused');

    const replaced = await bob('PUT', `/api/sets/${bobSetId}/items`, {
      items: [{ problem_id: aliceProblemId }],
    });
    assert.equal(replaced.body.items.length, 0, 'and refused on a wholesale replace');

    // Nor through the unsaved-set preview.
    const preview = await bob('POST', '/api/render/preview', {
      set: { title: 'probe', problem_ids: [aliceProblemId] },
    });
    assert.equal(preview.status, 422, 'nothing resolvable, so nothing to preview');
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

    await laptop('POST', '/api/problems', {
      subject: 'Portable', topic: 'Across devices', statement: 'Written on the laptop',
    });

    // A different browser, no cookie, but the bookmarked link.
    const phone = visitor(base);
    const restored = await phone('GET', `/api/workspace?w=${encodeURIComponent(token)}`);
    assert.equal(restored.body.id, info.body.id, 'same workspace');

    const found = await phone('GET', '/api/problems?q=laptop&limit=10');
    assert.equal(found.body.total, 1, 'and the same bank');

    // The cookie was set, so the link is not needed again.
    const again = await phone('GET', '/api/workspace');
    assert.equal(again.body.id, info.body.id);
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

test('a backup export covers only the visitor\'s own bank', async () => {
  await withServer({}, async ({ newVisitor }) => {
    const alice = newVisitor();
    const bob = newVisitor();

    await alice('POST', '/api/problems', {
      subject: 'Private', topic: 'Secret', statement: 'Alice backup marker',
    });

    // The panel's "Download a backup" link points here.
    const aliceExport = await alice('GET', '/api/problems/export');
    const bobExport = await bob('GET', '/api/problems/export');
    const marker = (payload) => payload.body.problems
      .some((problem) => problem.statement.includes('Alice backup marker'));

    assert.ok(marker(aliceExport), 'Alice gets her own problem');
    assert.ok(!marker(bobExport), "and it is absent from Bob's export");
    assert.equal(aliceExport.body.problems.length, bobExport.body.problems.length + 1);

    // A backup restores into whichever workspace imports it.
    const restored = await bob('POST', '/api/problems/import', {
      problems: aliceExport.body.problems.filter((p) => p.statement.includes('Alice backup marker')),
    });
    assert.equal(restored.body.created, 1);
    assert.equal((await bob('GET', '/api/problems?q=backup+marker&limit=5')).body.total, 1);
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

test('workspaces do not collide on the seeded external keys', async () => {
  await withServer({}, async ({ newVisitor, db }) => {
    const a = newVisitor();
    const b = newVisitor();
    const c = newVisitor();
    for (const who of [a, b, c]) {
      const facets = await who('GET', '/api/problems/facets');
      assert.ok(facets.body.total > 40, 'every workspace seeds fully');
    }
    // Same external_key in several workspaces is fine; duplicates within one are not.
    const rows = db.prepare(`SELECT external_key, COUNT(DISTINCT workspace_id) AS spaces, COUNT(*) AS rows
                             FROM problems WHERE external_key = 'alg1-two-step-linear'
                             GROUP BY external_key`).get();
    assert.equal(Number(rows.rows), Number(rows.spaces), 'one row per workspace, never two');
    assert.ok(Number(rows.spaces) >= 4);
  });
});
