// Running a shell test on its own — the command saved in a collection that the
// panel's Run button and MCP's run_saved_request both go through. What is worth
// proving here is that it behaves like a request in every way except what it
// does in the middle: same variable resolution, same script, same environment
// writes, and a verdict rather than a response.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// store.ts resolves DATA_DIR when it is first loaded, so point it at a scratch
// directory first. node:test runs each file in its own process, so this cannot
// leak into another test file.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-tool-shell-'));
process.env.DATA_DIR = DATA_DIR;

// ESM hoists every static import above this file's own statements, so the
// scratch DATA_DIR set above would otherwise be assigned *after* store.ts had
// already resolved it. Importing the two modules dynamically, at the point the old
// require() sat, keeps the original ordering: env var first, store second.
const { ensureDirs, environments } = await import('./store.ts');
const { runShellRequest, SendError } = await import('./runner.ts');
import type { RunShellRequestArgs } from './runner.ts';
import type { ShellRequest, ShellRunResult } from './types.ts';

const ENV = 'env-shell';

test.before(async () => {
  await ensureDirs();
  await environments.save({
    id: ENV,
    name: 'test',
    variables: { base_url: 'http://127.0.0.1:9', greeting: 'hello', widget_id: 'w-env' },
  });
});

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const shellTest = (extra: Partial<ShellRequest> = {}): ShellRequest => ({
  id: 'sh1', name: 'a check', kind: 'shell', command: 'echo ok', cwd: '', vars: [], script: '', ...extra,
});

const run = (
  extra: Partial<ShellRequest> = {},
  opts: Partial<RunShellRequestArgs> = {},
): Promise<ShellRunResult> => runShellRequest({
  collection: null,
  request: shellTest(extra),
  environmentId: ENV,
  ...opts,
});

test('a shell test runs its command and reports the verdict', async (t) => {
  const out = await run({ command: 'echo hello from a saved test' });

  await t.test('the exit code, not a status', () => {
    assert.equal(out.response.kind, 'shell');
    assert.equal(out.response.exitCode, 0);
    assert.ok(out.response.time >= 0);
  });

  await t.test('with what it printed', () => {
    assert.match(out.response.stdout, /hello from a saved test/);
    assert.equal(out.response.stderr, '');
  });

  await t.test('and the command it ran', () => {
    assert.equal(out.request.command, 'echo hello from a saved test');
    // Nothing was substituted, so there is no second version to report.
    assert.equal(out.request.commandRaw, undefined);
  });
});

test('a command that exits non-zero is a result, not a failure to run', async () => {
  const out = await run({ command: 'echo trouble >&2; exit 3' });
  assert.equal(out.response.exitCode, 3);
  assert.match(out.response.stderr, /trouble/);
});

test('variables resolve the way a request’s do', async (t) => {
  await t.test('from the environment', async () => {
    const out = await run({ command: 'echo "{{greeting}} there"' });
    assert.equal(out.request.command, 'echo "hello there"');
    // The line as typed is kept beside it: that is what you would go and edit.
    assert.equal(out.request.commandRaw, 'echo "{{greeting}} there"');
  });

  await t.test('with the test’s own values beating the environment', async () => {
    const out = await run({
      command: 'echo {{widget_id}}',
      vars: [{ key: 'widget_id', value: 'w-own', enabled: true }],
    });
    assert.match(out.response.stdout, /w-own/);
  });

  await t.test('and in the directory it runs in', async () => {
    const out = await run({ command: 'pwd', cwd: '{{tmp}}' }, { vars: { tmp: os.tmpdir() } });
    assert.equal(fs.realpathSync(out.response.stdout.trim()), fs.realpathSync(os.tmpdir()));
    assert.equal(out.request.cwd, os.tmpdir());
  });
});

test('the script runs after the command, and can keep a value', async (t) => {
  const out = await run({
    command: 'echo 42',
    script: "env.set('row_count', sh.stdout.trim())",
  });

  await t.test('sh carries the command’s result', () => {
    assert.deepEqual(out.script!.saved, { row_count: '42' });
  });

  await t.test('and env.set lands in the active environment', async () => {
    const env = (await environments.list()).find((e) => e.id === ENV)!;
    assert.equal(env.variables.row_count, '42');
  });

  await t.test('res reads the same result in a request’s shape', async () => {
    const back = await run({
      command: 'echo body-text',
      script: "env.set('as_status', String(res.status)); env.set('as_body', res.body.trim())",
    });
    assert.deepEqual(back.script!.saved, { as_status: '0', as_body: 'body-text' });
  });
});

test('a shell test with no command yet says so rather than running', async () => {
  await assert.rejects(() => run({ command: '   ' }), (err: Error) => {
    assert.ok(err instanceof SendError);
    assert.match(err.message, /shell test has no command/);
    return true;
  });
});

test('a command that outlives its timeout is killed and reported', async () => {
  await assert.rejects(() => run({ command: 'sleep 5', timeout: 300 }), (err: Error) => {
    assert.match(err.message, /did not finish within/);
    return true;
  });
});
