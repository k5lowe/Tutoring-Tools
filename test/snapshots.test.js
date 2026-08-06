'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snapshots = require('../server/lib/snapshots');
const { openMemory, open, openRaw } = require('../server/db');
const { createApp } = require('../server/app');
const problems = require('../server/store/problems');

/**
 * Backups.
 *
 * The point of these is that the restore path actually runs — a backup nobody
 * has restored from is a hypothesis, not a safety net. So the tests here write
 * real files to a temporary directory, open them as real databases, and put one
 * back over a real database.
 */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bank-snapshots-'));
}

/**
 * A directory path that cannot be created, for testing the failure path.
 * Its parent is a regular file, so mkdir fails with ENOTDIR immediately and
 * identically everywhere — unlike, say, a path under /proc.
 */
function unwritableDir() {
  const blocker = path.join(tempDir(), 'this-is-a-file');
  fs.writeFileSync(blocker, 'x');
  return path.join(blocker, 'snapshots');
}

function bankWith(count, prefix = 'Question') {
  const db = openMemory();
  for (let i = 1; i <= count; i += 1) {
    problems.create(db, {
      subject: 'Algebra 1', topic: 'Factoring', difficulty: 2,
      statement: `${prefix} ${i}`, answer: `$${i}$`,
    });
  }
  return db;
}

function visitor(base) {
  let cookie = null;
  return async (method, urlPath, body) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + urlPath, {
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

async function withApp({ db, snapshotDir, multiUser = false, adminKey = 'key' }, run) {
  const server = createApp(db, { snapshotDir, multiUser, adminKey }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, client: visitor(base), newVisitor: () => visitor(base) });
  } finally {
    server.close();
    await new Promise((resolve) => server.once('close', resolve));
  }
}

test('a snapshot is a whole database, not an export needing re-import', () => {
  const dir = tempDir();
  const db = bankWith(12);
  try {
    const result = snapshots.take(db, { dir, reason: 'manual' });
    assert.ok(!result.error, result.error);
    assert.ok(result.bytes > 0);
    assert.match(result.name, /^bank-\d{8}T\d{9}Z-manual\.db$/);

    // Opens directly as a bank, with the questions in it.
    const restored = open(result.file);
    try {
      const rows = restored.prepare('SELECT statement FROM problems ORDER BY id').all();
      assert.equal(rows.length, 12);
      assert.equal(rows[0].statement, 'Question 1');
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot is a moment, not a live view', () => {
  const dir = tempDir();
  const db = bankWith(3);
  try {
    const taken = snapshots.take(db, { dir, reason: 'before-bulk-delete' });
    db.exec('DELETE FROM problems');
    assert.equal(problems.count(db), 0, 'the live bank is empty');

    const restored = open(taken.file);
    try {
      assert.equal(Number(restored.prepare('SELECT COUNT(*) AS n FROM problems').get().n), 3,
        'the snapshot still has what was there before the delete');
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two snapshots in the same second do not overwrite each other', () => {
  const dir = tempDir();
  const db = bankWith(2);
  try {
    const now = new Date('2026-08-06T10:00:00Z');
    const first = snapshots.take(db, { dir, reason: 'manual', now });
    const second = snapshots.take(db, { dir, reason: 'manual', now });
    assert.ok(!first.error && !second.error);
    assert.notEqual(first.name, second.name);
    assert.equal(snapshots.list(dir).length, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed snapshot is reported, not thrown', () => {
  const db = bankWith(1);
  try {
    const result = snapshots.take(db, { dir: unwritableDir(), reason: 'manual' });
    assert.ok(result.error, 'it says what went wrong');
    assert.equal(typeof result.error, 'string');
  } finally {
    db.close();
  }
});

test('retention keeps recent, daily and weekly, and drops the rest', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  const at = (iso, reason = 'scheduled') => ({
    name: `bank-${iso.replace(/[-:.]/g, '')}-${reason}.db`,
    reason,
    takenAt: new Date(iso),
  });

  const entries = [
    at('2026-08-06T11:00:00Z', 'before-bulk-delete'),
    at('2026-08-06T09:00:00Z'),
    at('2026-08-06T03:00:00Z', 'before-import'),
    at('2026-08-05T12:00:00Z'),
    at('2026-08-05T02:00:00Z'),
    at('2026-07-30T12:00:00Z'),
    at('2026-07-30T01:00:00Z'),
    at('2026-06-01T12:00:00Z'),
    at('2025-01-01T12:00:00Z'),
  ].sort((a, b) => b.takenAt - a.takenAt);

  const keep = snapshots.keepers(entries, now);

  // Everything in the last 48 hours, however many there are that day.
  assert.ok(keep.has(at('2026-08-06T11:00:00Z', 'before-bulk-delete').name));
  assert.ok(keep.has(at('2026-08-06T09:00:00Z').name));
  assert.ok(keep.has(at('2026-08-06T03:00:00Z', 'before-import').name));
  assert.ok(keep.has(at('2026-08-05T12:00:00Z').name));
  assert.ok(keep.has(at('2026-08-05T02:00:00Z').name),
    'a second one on a recent day is still inside the 48-hour window');

  // Older days keep only their newest.
  assert.ok(keep.has(at('2026-07-30T12:00:00Z').name));
  assert.ok(!keep.has(at('2026-07-30T01:00:00Z').name), 'the older one that day goes');

  // Counted over what exists, so a long gap does not age everything out.
  assert.ok(keep.has(at('2026-06-01T12:00:00Z').name));
  assert.ok(keep.has(at('2025-01-01T12:00:00Z').name),
    'a bank left alone for a year still has its history');
});

test('pruning deletes files and keeps the newest', () => {
  const dir = tempDir();
  const db = bankWith(2);
  try {
    // Three on one old day; only the newest of them should survive.
    for (const time of ['T01:00:00Z', 'T02:00:00Z', 'T03:00:00Z']) {
      snapshots.take(db, { dir, reason: 'scheduled', now: new Date(`2026-01-05${time}`) });
    }
    snapshots.take(db, { dir, reason: 'manual', now: new Date('2026-08-06T10:00:00Z') });
    assert.equal(snapshots.list(dir).length, 4);

    const removed = snapshots.prune(dir, { now: new Date('2026-08-06T12:00:00Z') });
    const left = snapshots.list(dir).map((entry) => entry.name);
    assert.equal(removed.length, 2);
    assert.equal(left.length, 2);
    assert.ok(left.some((name) => name.includes('20260105T030000')), 'newest of the old day kept');
    assert.ok(left.some((name) => name.includes('20260806T100000')), 'the recent one kept');
    assert.ok(fs.readdirSync(dir).every((name) => left.includes(name)), 'and the files really went');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restoring puts the bank back, and keeps what it replaced', () => {
  const dir = tempDir();
  const home = tempDir();
  const live = path.join(home, 'bank.db');

  // A bank with good questions in it, and a snapshot of that moment.
  const db = open(live);
  for (let i = 1; i <= 5; i += 1) {
    problems.create(db, { subject: 'Algebra 1', topic: 'Good', statement: `Keeper ${i}` });
  }
  const taken = snapshots.take(db, { dir, reason: 'before-bulk-delete' });

  // Then the disaster: everything deleted, replaced with rubbish.
  problems.bulkDelete(db, {});
  problems.create(db, { subject: 'Oops', topic: 'Oops', statement: 'the only thing left' });
  assert.equal(problems.count(db), 1);
  db.close();

  try {
    const result = snapshots.restore(taken.file, live, openRaw);
    assert.equal(result.questions, 5, 'it checked the snapshot before touching anything');
    assert.ok(result.replaced && fs.existsSync(result.replaced),
      'the database it replaced was kept, in case this was the wrong snapshot');

    const back = open(live);
    try {
      const rows = back.prepare('SELECT statement FROM problems ORDER BY id').all();
      assert.equal(rows.length, 5);
      assert.deepEqual(rows.map((row) => row.statement),
        ['Keeper 1', 'Keeper 2', 'Keeper 3', 'Keeper 4', 'Keeper 5']);
    } finally {
      back.close();
    }

    // And the mistake is still recoverable in the other direction.
    const discarded = open(result.replaced);
    try {
      assert.equal(discarded.prepare('SELECT statement FROM problems').get().statement,
        'the only thing left');
    } finally {
      discarded.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('restoring refuses a file that is not a bank', () => {
  const dir = tempDir();
  try {
    // Built with openRaw, so it really has no bank schema — open() would have
    // created one and quietly made this a valid (empty) bank.
    const notABank = path.join(dir, 'notes.db');
    const other = openRaw(notABank);
    other.exec('CREATE TABLE shopping (item TEXT)');
    other.close();

    assert.throws(
      () => snapshots.restore(notABank, path.join(dir, 'live.db'), openRaw),
      /not a bank snapshot/,
    );
    assert.ok(!fs.existsSync(path.join(dir, 'live.db')), 'and it wrote nothing');

    assert.throws(() => snapshots.restore(path.join(dir, 'missing.db'), path.join(dir, 'x.db'), openRaw),
      /No such snapshot/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bulk delete takes a copy of the bank first', async () => {
  const dir = tempDir();
  const db = bankWith(20, 'Doomed');
  try {
    await withApp({ db, snapshotDir: dir }, async ({ client }) => {
      const before = snapshots.list(dir).length;
      const deleted = await client('POST', '/api/problems/bulk-delete', { filters: {}, expect: 20 });
      assert.equal(deleted.body.deleted, 20);
      assert.equal(deleted.body.snapshot.ok, true, 'the response says a copy was taken');

      const all = snapshots.list(dir);
      assert.equal(all.length, before + 1);
      assert.equal(all[0].reason, 'before-bulk-delete');

      // The questions the delete removed are in it.
      const copy = open(path.join(dir, all[0].name));
      try {
        assert.equal(Number(copy.prepare('SELECT COUNT(*) AS n FROM problems').get().n), 20,
          'so the delete that has no undo does have a way back');
      } finally {
        copy.close();
      }
      assert.equal((await client('GET', '/api/problems?limit=1')).body.total, 0);
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('imports and bulk changes take one too, and no-ops do not', async () => {
  const dir = tempDir();
  const db = bankWith(4);
  try {
    await withApp({ db, snapshotDir: dir }, async ({ client }) => {
      const empty = await client('POST', '/api/problems/import', { problems: [] });
      assert.equal(empty.body.snapshot, null, 'importing nothing is not worth a backup');
      assert.equal(snapshots.list(dir).length, 0);

      await client('POST', '/api/problems/import', {
        problems: [{ subject: 'Geometry', topic: 'Circles', statement: 'New one' }],
      });
      assert.deepEqual(snapshots.list(dir).map((entry) => entry.reason), ['before-import']);

      await client('POST', '/api/problems/bulk', {
        filters: { subject: 'Algebra 1' }, changes: { difficulty: 5 },
      });
      assert.deepEqual(snapshots.list(dir).map((entry) => entry.reason),
        ['before-bulk-change', 'before-import']);
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bulk delete still runs when the backup cannot be written', async () => {
  const db = bankWith(3);
  try {
    // Snapshots configured, but the directory is unwritable.
    await withApp({ db, snapshotDir: unwritableDir() }, async ({ client }) => {
      const deleted = await client('POST', '/api/problems/bulk-delete', { filters: {}, expect: 3 });
      assert.equal(deleted.status, 200, 'the work asked for still happens');
      assert.equal(deleted.body.deleted, 3);
      assert.equal(deleted.body.snapshot.ok, false, 'but it says the safety net was missing');
      assert.ok(deleted.body.snapshot.error);
    });
  } finally {
    db.close();
  }
});

test('with snapshots off, nothing is written and nothing is claimed', async () => {
  const db = bankWith(3);
  try {
    await withApp({ db, snapshotDir: null }, async ({ client }) => {
      const deleted = await client('POST', '/api/problems/bulk-delete', { filters: {}, expect: 3 });
      assert.equal(deleted.body.deleted, 3);
      assert.equal(deleted.body.snapshot, null, 'no safety net is claimed');

      const listed = await client('GET', '/api/snapshots');
      assert.equal(listed.body.enabled, false);
      assert.equal((await client('POST', '/api/snapshots')).status, 503);
    });
  } finally {
    db.close();
  }
});

test('the owner can list, take and download a snapshot; visitors cannot', async () => {
  const dir = tempDir();
  const db = bankWith(6);
  try {
    await withApp({ db, snapshotDir: dir, multiUser: true, adminKey: 'correct-horse' },
      async ({ newVisitor }) => {
        const student = newVisitor();
        for (const [method, urlPath] of [['GET', '/api/snapshots'], ['POST', '/api/snapshots']]) {
          const refused = await student(method, urlPath);
          assert.equal(refused.status, 403, `${method} ${urlPath} must be refused`);
        }

        const owner = newVisitor();
        await owner('POST', '/api/admin/unlock', { key: 'correct-horse' });

        const taken = await owner('POST', '/api/snapshots');
        assert.equal(taken.status, 201);
        assert.equal(taken.body.reason, 'manual');

        const listed = await owner('GET', '/api/snapshots');
        assert.equal(listed.body.enabled, true);
        assert.equal(listed.body.snapshots.length, 1);
        assert.equal(listed.body.last.name, taken.body.name);

        // Downloading is how a copy gets off this disk.
        const download = await owner('GET', `/api/snapshots/${taken.body.name}`);
        assert.equal(download.status, 200);
        assert.match(download.headers.get('content-disposition') || '', /attachment/);

        assert.equal((await student('GET', `/api/snapshots/${taken.body.name}`)).status, 403,
          'and a visitor cannot help themselves to the whole bank');
      });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the download route cannot be talked into leaving its directory', async () => {
  const dir = tempDir();
  const db = bankWith(2);
  const secret = path.join(dir, '..', `secret-${process.pid}.txt`);
  fs.writeFileSync(secret, 'not yours');
  try {
    await withApp({ db, snapshotDir: dir }, async ({ client }) => {
      for (const attempt of [
        '../' + path.basename(secret),
        '..%2F' + path.basename(secret),
        '....//' + path.basename(secret),
        encodeURIComponent('../../etc/passwd'),
        'bank-20260806T100000Z-manual.db/../../../etc/passwd',
      ]) {
        const response = await client('GET', `/api/snapshots/${attempt}`);
        assert.ok(response.status === 404 || response.status === 400,
          `"${attempt}" should not resolve (got ${response.status})`);
        assert.ok(!String(response.body).includes('not yours'), 'and never returns the file');
      }
    });
  } finally {
    db.close();
    fs.rmSync(secret, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scheduler takes one immediately and can be switched off', () => {
  const dir = tempDir();
  const db = bankWith(2);
  try {
    const stop = snapshots.schedule(db, { dir, hours: 0 });
    const all = snapshots.list(dir);
    assert.equal(all.length, 1, 'hours: 0 still takes the one at startup');
    assert.equal(all[0].reason, 'startup');
    assert.equal(typeof stop, 'function');
    stop();
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
