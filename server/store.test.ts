// The file store's own rules: which ids it will turn into a path, that only
// one environment is the default at a time, and that one bad file does not
// take a whole listing down.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// store.ts resolves DATA_DIR when it is first loaded, so point it at a scratch
// directory first. node:test runs each file in its own process, so this cannot
// leak into another test file.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-tool-store-'));
process.env.DATA_DIR = DATA_DIR;

// ESM hoists every static import above this file's own statements, so the
// scratch DATA_DIR set above would otherwise be assigned *after* store.ts had
// already resolved it. Importing dynamically keeps the ordering: env var
// first, store second.
const { ensureDirs, collections, environments, flows, InvalidId } = await import('./store.ts');

test.before(async () => {
  await ensureDirs();
});

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('an id that could name a file outside its directory', async (t) => {
  const escaped = path.join(DATA_DIR, 'escaped.json');

  await t.test('reads as not found', async () => {
    assert.equal(await collections.get('../escaped'), null);
    assert.equal(await environments.get('a/b'), null);
    assert.equal(await flows.get('..'), null);
    assert.equal(await collections.update('../escaped', (c) => c), null);
  });

  await t.test('removes as not found', async () => {
    assert.equal(await collections.remove('../escaped'), false);
    assert.equal(await environments.remove('../escaped'), false);
    assert.equal(await flows.remove('../escaped'), false);
  });

  await t.test('is refused on save, with the status the API answers with', async () => {
    // An async wrapper, because the refusal is raised before any file work
    // starts and assert.rejects wants a promise either way.
    const refused = (err: unknown): boolean => {
      assert.ok(err instanceof InvalidId);
      assert.equal(err.status, 400);
      return true;
    };
    await assert.rejects(async () => collections.save({ id: '../escaped', name: 'x' }), refused);
    await assert.rejects(async () => environments.save({ id: '../escaped', name: 'x' }), refused);
    await assert.rejects(async () => flows.save({ id: '../escaped', name: 'x' }), refused);
    assert.equal(fs.existsSync(escaped), false);
  });

  await t.test('while the ids this tool makes, hyphens and underscores included, pass', async () => {
    await collections.save({ id: 'col-test_1', name: 'kept' });
    assert.equal((await collections.get('col-test_1'))!.name, 'kept');
    assert.equal(await collections.remove('col-test_1'), true);
  });
});

test('environments.save keeps one default at a time', async (t) => {
  const a = await environments.save({ id: 'env-a', name: 'a', isDefault: true });
  assert.equal(a.isDefault, true);

  await t.test('marking another unmarks the one that was', async () => {
    const b = await environments.save({ id: 'env-b', name: 'b', isDefault: true });
    assert.equal(b.isDefault, true);
    assert.equal((await environments.get('env-a'))!.isDefault, undefined);
    assert.equal((await environments.get('env-b'))!.isDefault, true);
  });

  await t.test('a save that says nothing about the flag keeps it', async () => {
    // The editor saves name and variables as they are typed and never
    // mentions the default.
    await environments.save({ id: 'env-b', name: 'b, renamed' });
    assert.equal((await environments.get('env-b'))!.isDefault, true);
    assert.equal((await environments.get('env-a'))!.isDefault, undefined);
  });
});

test('a corrupt file is skipped by the listing, and named', async (t) => {
  await flows.save({ id: 'flow-good', name: 'good' });
  fs.writeFileSync(path.join(DATA_DIR, 'flows', 'broken.json'), '{ "id": "broken", ');
  // Reported rather than silently dropped — but not to this test's output.
  const logged = t.mock.method(console, 'error', () => {});

  const list = await flows.list();
  assert.deepEqual(list.map((f) => f.id), ['flow-good']);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0]!.arguments[0]), /broken\.json/);
});
