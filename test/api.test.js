'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openMemory, DEFAULT_WORKSPACE_ID } = require('../server/db');
const { createApp } = require('../server/app');
const { seedAll } = require('../scripts/seed');

/** Start the real app against an in-memory database and return a client. */
async function withServer(run) {
  const db = openMemory();
  seedAll(db, DEFAULT_WORKSPACE_ID, { force: true });
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const client = async (method, path, body) => {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(base + path, options);
    const type = response.headers.get('content-type') || '';
    return {
      status: response.status,
      headers: response.headers,
      body: type.includes('json') ? await response.json() : await response.text(),
    };
  };

  try {
    await run({ client, db, base });
  } finally {
    server.close();
    await new Promise((resolve) => server.once('close', resolve));
    db.close();
  }
}

test('the seed bank loads and every template problem generates', async () => {
  await withServer(async ({ client }) => {
    const facets = await client('GET', '/api/problems/facets');
    assert.equal(facets.status, 200);
    assert.ok(facets.body.total > 40, 'a useful starter bank');
    assert.ok(facets.body.subjects.length >= 5);
    assert.ok(facets.body.tags.length > 20);

    // render=1 exercises the LaTeX -> HTML path on every problem in the bank.
    const listed = await client('GET', '/api/problems?limit=500&render=1');
    assert.equal(listed.status, 200);
    const broken = listed.body.items.filter((problem) => problem.html.error);
    assert.deepEqual(broken.map((problem) => problem.topic), [], 'no problem fails to render');
    assert.ok(listed.body.items.every((problem) => problem.html.statement.length > 0));
  });
});

test('filters narrow the bank', async () => {
  await withServer(async ({ client }) => {
    const all = await client('GET', '/api/problems?limit=1');
    const geometry = await client('GET', '/api/problems?subject=Geometry&limit=1');
    assert.ok(geometry.body.total > 0);
    assert.ok(geometry.body.total < all.body.total);

    const tagged = await client('GET', '/api/problems?tags=factoring&limit=100');
    assert.ok(tagged.body.items.length > 0);
    assert.ok(tagged.body.items.every((problem) => problem.tags.includes('factoring')));

    const hard = await client('GET', '/api/problems?difficulties=4,5&limit=100');
    assert.ok(hard.body.items.every((problem) => problem.difficulty >= 4));

    const templates = await client('GET', '/api/problems?kind=template&limit=100');
    assert.ok(templates.body.items.every((problem) => problem.kind === 'template'));

    const searched = await client('GET', '/api/problems?q=quadratic%20formula&limit=10');
    assert.ok(searched.body.total > 0);
  });
});

test('problem CRUD, with template validation feedback', async () => {
  await withServer(async ({ client }) => {
    const created = await client('POST', '/api/problems', {
      subject: 'Trigonometry',
      topic: 'Identities',
      difficulty: 4,
      kind: 'template',
      statement: 'Simplify $\\sin^2\\theta + \\cos^2\\theta + {{a}}$.',
      answer: '${{a + 1}}$',
      params: { vars: { a: { type: 'int', min: 1, max: 5 } } },
      tags: ['Trig', 'identities', 'trig'],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.check.ok, true);
    assert.deepEqual(created.body.problem.tags, ['trig', 'identities'], 'tags are lower-cased and de-duplicated');

    const id = created.body.problem.id;
    const updated = await client('PUT', `/api/problems/${id}`, {
      ...created.body.problem, difficulty: 9,
    });
    assert.equal(updated.body.problem.difficulty, 5, 'difficulty is clamped to 1-5');

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

test('export round-trips back through import without duplicating', async () => {
  await withServer(async ({ client }) => {
    const before = (await client('GET', '/api/problems?limit=1')).body.total;
    const exported = await client('GET', '/api/problems/export');
    assert.equal(exported.status, 200);
    assert.equal(exported.body.problems.length, before);

    const reimported = await client('POST', '/api/problems/import', exported.body);
    assert.equal(reimported.body.updated, before);
    assert.equal(reimported.body.created, 0);
    assert.deepEqual(reimported.body.errors, []);
    assert.equal((await client('GET', '/api/problems?limit=1')).body.total, before);
  });
});

test('generating a set, then rendering practice and key in agreement', async () => {
  await withServer(async ({ client }) => {
    const generated = await client('POST', '/api/sets/generate', {
      title: 'Ch 4 Review',
      count: 6,
      distribution: 'mixed',
      numbering: 'sequential',
      versions: 3,
      filters: { subject: 'Algebra 2' },
      meta: { course: 'Algebra 2', instructions: 'Show all work.' },
    });
    assert.equal(generated.status, 201);
    const set = generated.body.set;
    assert.equal(set.items.length, 6);

    const practice = await client('GET', `/api/render/sets/${set.id}?kind=practice&version=A`);
    assert.equal(practice.status, 200);
    assert.deepEqual(practice.body.warnings, []);
    assert.match(practice.body.latex, /\\documentclass/);
    assert.match(practice.body.latex, /\\begin\{document\}/);
    assert.match(practice.body.latex, /Ch 4 Review/);
    assert.match(practice.body.latex, /Show all work/);
    assert.equal(practice.body.filename, 'ch-4-review-practice-a.tex');
    assert.match(practice.body.html, /class="katex"/, 'math is rendered for the preview');

    // The key must be generated from the same draw as the worksheet: a template
    // problem's answer is only correct for its own seed.
    const key = await client('GET', `/api/render/sets/${set.id}?kind=answers&version=A`);
    assert.match(key.body.latex, /Answer Key/);
    const answers = set.items.map((item) => item.answer).filter(Boolean);
    assert.ok(answers.length > 0);

    const versionB = await client('GET', `/api/render/sets/${set.id}?kind=practice&version=B`);
    assert.notEqual(versionB.body.latex, practice.body.latex, 'version B is a different draw');
    assert.equal(versionB.body.versionLabel, 'B');

    const again = await client('GET', `/api/render/sets/${set.id}?kind=practice&version=B`);
    assert.equal(again.body.latex, versionB.body.latex, 'and is reproducible');
  });
});

test('the printable page matches what each template emits', async () => {
  await withServer(async ({ client }) => {
    const generated = await client('POST', '/api/sets/generate', {
      title: 'Parity', count: 4, filters: { subject: 'Calculus 1' },
      meta: { instructions: 'No calculator.', objectives: ['Differentiate polynomials'] },
    });
    const setId = generated.body.set.id;

    const practice = await client('GET', `/print/${setId}?kind=practice`);
    assert.match(practice.body, /No calculator/);
    assert.match(practice.body, /Name:/, 'a worksheet carries a name line');
    assert.doesNotMatch(practice.body, /class="solution"/, 'no solutions on the worksheet');

    const notes = await client('GET', `/print/${setId}?kind=notes`);
    assert.match(notes.body, /Objectives/);
    assert.match(notes.body, /class="solution"|answer-line/, 'notes carry worked solutions');

    // The key is for the tutor; the student-facing preamble is dropped, exactly
    // as the answers template does.
    const answers = await client('GET', `/print/${setId}?kind=answers`);
    assert.match(answers.body, /Answer Key/);
    assert.doesNotMatch(answers.body, /No calculator/);
    assert.doesNotMatch(answers.body, /Objectives/);
    assert.match(answers.body, /class="columns"/, 'the key is laid out in columns');
  });
});

test('a generated worksheet and its key describe the same problems', async () => {
  await withServer(async ({ client, db }) => {
    // Use only template problems, where a mismatched seed would be visible.
    const generated = await client('POST', '/api/sets/generate', {
      title: 'Templates only',
      count: 8,
      filters: { kind: 'template' },
    });
    const setId = generated.body.set.id;

    const practice = await client('GET', `/api/render/sets/${setId}?kind=practice`);
    const key = await client('GET', `/api/render/sets/${setId}?kind=answers`);

    const items = db.prepare(
      'SELECT problem_id, seed FROM set_items WHERE set_id = ? ORDER BY position',
    ).all(setId);
    const { instantiate } = require('../server/lib/variants');
    const problems = require('../server/store/problems');

    for (const item of items) {
      const problem = problems.get(db, DEFAULT_WORKSPACE_ID, item.problem_id);
      const instance = instantiate(problem, item.seed);
      assert.ok(
        practice.body.latex.includes(instance.statement.trim()),
        `worksheet contains the statement for problem ${item.problem_id}`,
      );
      if (instance.answer.trim()) {
        assert.ok(
          key.body.latex.includes(instance.answer.trim()),
          `key contains the matching answer for problem ${item.problem_id}`,
        );
      }
    }
  });
});

test('editing a set: reorder, reseed, sort, add and remove', async () => {
  await withServer(async ({ client }) => {
    const generated = await client('POST', '/api/sets/generate', {
      title: 'Editing', count: 5, filters: { subject: 'Algebra 1' },
    });
    const setId = generated.body.set.id;
    const original = generated.body.set.items.map((item) => item.problem_id);

    const moved = await client('POST', `/api/sets/${setId}/items/${generated.body.set.items[0].item_id}/move`, { to: 4 });
    assert.equal(moved.body.items[4].problem_id, original[0]);
    assert.deepEqual(moved.body.items.map((item) => item.position), [0, 1, 2, 3, 4]);

    const templateItems = moved.body.items.filter((item) => item.kind === 'template');
    if (templateItems.length > 0) {
      const before = templateItems.map((item) => item.seed);
      const reseeded = await client('POST', `/api/sets/${setId}/reseed`);
      const after = reseeded.body.items.filter((item) => item.kind === 'template').map((item) => item.seed);
      assert.notDeepEqual(after, before, 'reseeding draws new numbers');
    }

    const sorted = await client('POST', `/api/sets/${setId}/sort`, { by: 'section' });
    const sections = sorted.body.items.map((item) => Number.parseFloat(item.source_section) || 0);
    assert.deepEqual(sections, [...sections].sort((a, b) => a - b));
    assert.equal((await client('POST', `/api/sets/${setId}/sort`, { by: 'nonsense' })).status, 400);

    const extra = await client('GET', '/api/problems?subject=Geometry&limit=2');
    const added = await client('POST', `/api/sets/${setId}/items`, {
      problem_ids: extra.body.items.map((problem) => problem.id),
    });
    assert.equal(added.body.items.length, 7);

    const removed = await client('DELETE', `/api/sets/${setId}/items/${added.body.items[0].item_id}`);
    assert.equal(removed.body.items.length, 6);

    const topped = await client('POST', `/api/sets/${setId}/items/generate`, {
      count: 3, filters: { subject: 'Algebra 1' },
    });
    assert.equal(topped.body.items.length, 9);
    const staticIds = topped.body.items
      .filter((item) => item.kind === 'static')
      .map((item) => item.problem_id);
    assert.equal(new Set(staticIds).size, staticIds.length,
      'a top-up never repeats a fixed problem');
    const seeds = topped.body.items
      .filter((item) => item.kind === 'template')
      .map((item) => item.seed);
    assert.equal(new Set(seeds).size, seeds.length,
      'a repeated template problem gets its own seed, so it is a different problem');
  });
});

test('grouped numbering emits each section heading once', async () => {
  await withServer(async ({ client }) => {
    // Deliberately interleave sections by appending in two passes.
    const generated = await client('POST', '/api/sets/generate', {
      title: 'Grouped', count: 6, numbering: 'section', filters: { subject: 'Algebra 2' },
    });
    const setId = generated.body.set.id;
    await client('POST', `/api/sets/${setId}/items/generate`, {
      count: 6, filters: { subject: 'Algebra 2' },
    });

    const rendered = await client('GET', `/api/render/sets/${setId}?kind=practice`);
    const headings = [...rendered.body.latex.matchAll(/\\problemheading\{ ([^}]*) \}/g)]
      .map((match) => match[1]);
    assert.ok(headings.length > 0, 'headings are produced');
    assert.equal(new Set(headings).size, headings.length,
      'no section heading appears twice');

    // The on-screen list must be in the same order as the printed document.
    const listed = await client('GET', `/api/sets/${setId}?render=1`);
    const listHeadings = listed.body.set.items.map((item) => item.heading).filter(Boolean);
    assert.deepEqual(listHeadings, headings, 'the builder list matches the output');
  });
});

test('generating with impossible filters reports it instead of an empty set', async () => {
  await withServer(async ({ client }) => {
    const response = await client('POST', '/api/sets/generate', {
      title: 'Nothing', count: 5, filters: { subject: 'Underwater Basket Weaving' },
    });
    assert.equal(response.status, 422);
    assert.match(response.body.error, /No problems/);
    assert.equal(response.body.poolSize, 0);
  });
});

test('downloads: single .tex, and a bundle of all versions and keys', async () => {
  await withServer(async ({ client }) => {
    const generated = await client('POST', '/api/sets/generate', {
      title: 'Downloads', count: 4, versions: 3, filters: { subject: 'Geometry' },
    });
    const setId = generated.body.set.id;

    const single = await client('GET', `/download/${setId}/tex?kind=practice&version=A`);
    assert.equal(single.status, 200);
    assert.match(single.headers.get('content-type'), /application\/x-tex/);
    assert.match(single.headers.get('content-disposition'), /downloads-practice-a\.tex/);
    assert.equal((single.body.match(/documentclass/g) || []).length, 1);

    const bundle = await client('GET', `/download/${setId}/tex?kinds=practice,answers&versions=all`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-disposition'), /downloads-all\.tex/);
    assert.equal((bundle.body.match(/documentclass/g) || []).length, 1, 'one preamble for the whole bundle');
    assert.equal((bundle.body.match(/\\newpage/g) || []).length, 5, '6 documents, 5 breaks');
    assert.match(bundle.body, /usepackage\{multicol\}/, 'the key template\'s package is carried over');
    assert.equal((bundle.body.match(/Answer Key/g) || []).length, 3);

    const printed = await client('GET', `/print/${setId}?kind=practice`);
    assert.equal(printed.status, 200);
    assert.match(printed.body, /<!doctype html>/i);
    assert.match(printed.body, /katex\.min\.css/);
    assert.match(printed.body, /window\.print\(\)/);
  });
});

test('PDF endpoint compiles when a TeX engine exists, and degrades honestly when not', async () => {
  await withServer(async ({ client }) => {
    const generated = await client('POST', '/api/sets/generate', {
      title: 'Pdf', count: 6, versions: 2, meta: { instructions: '50% of these are easy.' },
    });
    const setId = generated.body.set.id;
    const status = await client('GET', '/api/render/pdf-status');
    const single = await client('GET', `/download/${setId}/pdf?kind=practice`);

    if (!status.body.available) {
      assert.equal(single.status, 501);
      assert.match(single.body.error, /No LaTeX engine/);
      return;
    }

    assert.equal(single.status, 200, `expected a PDF, got: ${JSON.stringify(single.body).slice(0, 300)}`);
    assert.match(single.headers.get('content-type'), /application\/pdf/);
    assert.ok(single.body.startsWith('%PDF-'), 'the response really is a PDF');

    // The bundle merges preambles from several templates; it has to build too.
    const bundle = await client('GET', `/download/${setId}/pdf?kinds=practice,notes,answers&versions=all`);
    assert.equal(bundle.status, 200, `bundle failed: ${JSON.stringify(bundle.body).slice(0, 400)}`);
    assert.ok(bundle.body.startsWith('%PDF-'));
    assert.ok(bundle.body.length > single.body.length, 'the bundle is the larger document');

    // A template that cannot build should report the TeX error, not a 500.
    const templates = (await client('GET', '/api/templates?kind=practice')).body.templates;
    await client('PUT', `/api/templates/${templates[0].id}`, {
      body: '\\documentclass{article}\\begin{document}\\thisIsNotACommand\\end{document}',
    });
    const broken = await client('GET', `/download/${setId}/pdf?kind=practice`);
    assert.equal(broken.status, 422);
    assert.match(broken.body.error, /LaTeX build failed/);
    await client('POST', `/api/templates/${templates[0].id}/reset`);
  });
});

test('rendering an unsaved set for preview', async () => {
  await withServer(async ({ client }) => {
    const problems = await client('GET', '/api/problems?limit=3&kind=template');
    const ids = problems.body.items.map((problem) => problem.id);

    const preview = await client('POST', '/api/render/preview', {
      kind: 'practice',
      set: { title: 'Scratch', numbering: 'sequential', problem_ids: ids },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.count, 3);

    const again = await client('POST', '/api/render/preview', {
      kind: 'practice',
      set: { title: 'Scratch', numbering: 'sequential', problem_ids: ids },
    });
    assert.equal(again.body.latex, preview.body.latex, 'ad-hoc previews are deterministic');

    const empty = await client('POST', '/api/render/preview', { set: { problem_ids: [] } });
    assert.equal(empty.status, 422);
  });
});

test('templates: edit, default, reset, and validation', async () => {
  await withServer(async ({ client }) => {
    const listed = await client('GET', '/api/templates');
    assert.ok(listed.body.templates.length >= 4);
    const practice = listed.body.templates.find((template) => template.kind === 'practice');

    const badBody = await client('PUT', `/api/templates/${practice.id}`, { body: '{{#problems}}unclosed' });
    assert.equal(badBody.status, 400);
    assert.match(badBody.body.error, /unclosed/);

    const edited = await client('PUT', `/api/templates/${practice.id}`, {
      body: '\\documentclass{article}\\begin{document}CUSTOM{{#problems}} {{label}}{{/problems}}\\end{document}',
    });
    assert.equal(edited.status, 200);

    const generated = await client('POST', '/api/sets/generate', { title: 'Uses custom', count: 2 });
    const rendered = await client('GET', `/api/render/sets/${generated.body.set.id}?kind=practice`);
    assert.match(rendered.body.latex, /CUSTOM/, 'the edited template is what gets used');

    const reset = await client('POST', `/api/templates/${practice.id}/reset`);
    assert.match(reset.body.template.body, /problemindent/, 'reset restores the shipped body');

    assert.equal((await client('DELETE', `/api/templates/${practice.id}`)).status, 400,
      'built-in templates cannot be deleted');

    const custom = await client('POST', '/api/templates', {
      name: 'Mine', kind: 'answers', body: 'x', is_default: true,
    });
    assert.equal(custom.status, 201);
    assert.equal(custom.body.template.is_default, true);
    const answerTemplates = (await client('GET', '/api/templates?kind=answers')).body.templates;
    assert.equal(answerTemplates.filter((template) => template.is_default).length, 1,
      'exactly one default per kind');
    assert.equal((await client('DELETE', `/api/templates/${custom.body.template.id}`)).status, 204);
  });
});

test('sets can be duplicated and listed, and 404s are reported as JSON', async () => {
  await withServer(async ({ client }) => {
    const generated = await client('POST', '/api/sets/generate', { title: 'Original', count: 3 });
    const setId = generated.body.set.id;

    const copy = await client('POST', `/api/sets/${setId}/duplicate`, {});
    assert.equal(copy.status, 201);
    assert.equal(copy.body.set.title, 'Original (copy)');
    assert.equal(copy.body.set.items.length, 3);
    assert.deepEqual(
      copy.body.set.items.map((item) => item.seed),
      generated.body.set.items.map((item) => item.seed),
      'a duplicate reprints identically until it is reseeded',
    );

    const listed = await client('GET', '/api/sets');
    assert.equal(listed.body.sets.length, 2);
    assert.ok(listed.body.sets.every((set) => Number.isFinite(set.item_count)));

    assert.equal((await client('DELETE', `/api/sets/${setId}`)).status, 204);
    assert.equal((await client('GET', `/api/sets/${setId}`)).status, 404);
    assert.equal((await client('GET', '/api/render/sets/99999')).status, 404);
    const missing = await client('GET', '/api/nope');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /No such endpoint/);
  });
});

test('deleting a problem removes it from the sets that used it', async () => {
  await withServer(async ({ client }) => {
    const generated = await client('POST', '/api/sets/generate', { title: 'Cascade', count: 4 });
    const setId = generated.body.set.id;
    const victim = generated.body.set.items[0].problem_id;

    assert.equal((await client('DELETE', `/api/problems/${victim}`)).status, 204);
    const after = await client('GET', `/api/sets/${setId}`);
    assert.equal(after.body.set.items.length, 3);
    assert.ok(after.body.set.items.every((item) => item.problem_id !== victim));
  });
});

test('the app serves its own front end', async () => {
  await withServer(async ({ client }) => {
    const page = await client('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /Tutoring Tools/);
    assert.match(page.body, /js\/app\.js/);
    assert.equal((await client('GET', '/js/app.js')).status, 200);
    assert.equal((await client('GET', '/css/app.css')).status, 200);
    assert.equal((await client('GET', '/vendor/katex/katex.min.css')).status, 200);
  });
});
