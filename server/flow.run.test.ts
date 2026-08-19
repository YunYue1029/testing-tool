// runFlow end to end, against a real HTTP target on loopback. What is worth
// proving here is the orchestration, not the HTTP: values passing from one step
// to the next, a failure stopping the chain, teardown running anyway, and run
// variables never reaching the stored environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Auth, FlowReport, HttpRequest, SavedRequest, StepInput } from './types.ts';

// store.ts resolves DATA_DIR when it is first loaded, so point it at a scratch
// directory first. node:test runs each file in its own process, so this cannot
// leak into another test file.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-tool-flow-'));
process.env.DATA_DIR = DATA_DIR;

// ESM hoists every static import above this file's own statements, so the
// scratch DATA_DIR set above would otherwise be assigned *after* store.ts had
// already resolved it. Importing the two modules dynamically, at the point the old
// require() sat, keeps the original ordering: env var first, store second.
const { ensureDirs, collections, environments, flows } = await import('./store.ts');
const { runFlow } = await import('./flow.ts');

// ---- a target API to point the flow at ----
let deleted: string[] = [];
const target = http.createServer((req, res) => {
  const url = ((req.url || '').split('?')[0].replace(/\/+$/, '')) || '/';
  const send = (status: number, payload: unknown) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };
  if (req.method === 'POST' && url === '/widgets') return send(201, { data: { id: 'w7' } });
  if (req.method === 'GET' && url === '/widgets/w7') return send(200, { data: { id: 'w7', name: 'thing' } });
  if (req.method === 'DELETE' && url === '/widgets/w7') { deleted.push('w7'); return send(200, { ok: true }); }
  if (req.method === 'GET' && url === '/widgets/boom') return send(500, { error: 'nope' });
  if (req.method === 'GET' && url === '/echo') return send(200, { auth: req.headers.authorization || null });
  return send(404, { error: 'no route' });
});

// ---- fixtures ----
const COL = 'col-test';
const COL_AUTH = 'col-auth';
const ENV = 'env-test';
const body = (content: string): Partial<HttpRequest> => ({
  bodyType: 'json',
  bodies: [{ id: 'b1', name: 'Default', content }],
  activeBodyId: 'b1',
});
const request = (id: string, method: string, url: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
  id, name: id, method, url, params: [], headers: [], folderId: 'f-widgets', script: '', ...extra,
});

test.before(async () => {
  await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', () => resolve()); });
  const port = (target.address() as AddressInfo).port;

  await ensureDirs();
  await environments.save({
    id: ENV,
    name: 'test',
    // `tok` is only for the auth fixtures below; nothing else resolves it.
    variables: { base_url: `http://127.0.0.1:${port}`, tok: 'secret' },
  });
  // A collection whose default auth an inline step can inherit, refuse, or
  // replace. Kept apart from COL so the flows above keep going out bare.
  await collections.save({
    id: COL_AUTH,
    name: 'Guarded',
    folders: [],
    auth: { type: 'bearer', token: '{{tok}}' },
    requests: [],
  });
  await collections.save({
    id: COL,
    name: 'Widgets',
    folders: [{ id: 'f-widgets', name: 'widgets', parentId: null }],
    requests: [
      request('create', 'POST', '{{dy_url}}/', body('{"name":"thing"}')),
      request('read', 'GET', '{{dy_url}}/{{widget_id}}'),
      request('remove', 'DELETE', '{{dy_url}}/{{widget_id}}'),
      request('boom', 'GET', '{{dy_url}}/boom'),
      // A login-shaped request: its own script captures a token.
      request('login', 'POST', '{{dy_url}}/', {
        ...body('{"name":"thing"}'),
        script: "env.set('token', res.json().data.id)",
      }),
      // A saved test that runs a command instead of sending anything. It is
      // filed here beside the endpoints it checks, and a step points at it the
      // same way it points at a request.
      {
        id: 'row-check',
        name: 'the row is really there',
        kind: 'shell',
        command: 'echo "row {{widget_id}} at {{base_url}}"',
        cwd: '',
        // Its own value for the id, so it can be run on its own — a flow that
        // captured a real one must still win over this.
        vars: [{ key: 'widget_id', value: 'w-saved', enabled: true }],
        script: '',
      } satisfies SavedRequest,
      // Lives at the collection root, so {{dy_url}} is just base_url.
      request('echo', 'GET', '{{dy_url}}/echo', {
        folderId: null,
        headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
      }),
    ],
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => { target.close(() => resolve()); });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const step = (requestId: string, extra: Partial<StepInput> = {}): StepInput => ({
  name: requestId, collectionId: COL, requestId, ...extra,
});

const run = async (name: string, steps: StepInput[]): Promise<FlowReport> => {
  deleted = [];
  const flow = await flows.save({ name, steps });
  return runFlow(flow, { environmentId: ENV });
};

test('a passing CRUD flow', async (t) => {
  const report = await run('crud', [
    step('create', {
      extract: [{ var: 'widget_id', from: 'body', path: 'data.id' }],
      assert: [{ source: 'status', op: 'eq', value: '201' }],
    }),
    step('read', {
      assert: [{ source: 'body', path: 'data.name', op: 'eq', value: 'thing' }],
    }),
    step('remove', { always: true, assert: [{ source: 'status', op: 'eq', value: '200' }] }),
  ]);

  await t.test('reports ok with every step passing', () => {
    assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
    assert.deepEqual(report.steps.map((s) => s.ok), [true, true, true]);
  });

  await t.test('passes the extracted id to the next step', () => {
    assert.equal(report.vars.widget_id, 'w7');
    assert.equal(report.steps[0].extracted!.widget_id, 'w7');
    // The read step could only have hit this URL with the id filled in.
    assert.match(report.steps[1].request!.url, /\/widgets\/w7$/);
  });

  await t.test('actually called the delete', () => {
    assert.deepEqual(deleted, ['w7']);
  });

  // A passing run is worth reading too: which of the three calls returned the
  // list you expected is only answerable if every step kept its response.
  await t.test('keeps what each passing step got back', () => {
    assert.match(report.steps[0].response!.body, /w7/);
    assert.equal(report.steps[0].response!.truncated, false);
    assert.ok(report.steps[0].response!.headers);
  });
});

test('a failing step stops the chain but not the teardown', async (t) => {
  const report = await run('failing', [
    step('create', { extract: [{ var: 'widget_id', from: 'body', path: 'data.id' }] }),
    step('boom', { assert: [{ source: 'status', op: 'eq', value: '200' }] }),
    step('read'),
    step('remove', { always: true }),
  ]);

  await t.test('the run fails', () => {
    assert.equal(report.ok, false);
    assert.equal(report.steps[1].ok, false);
  });

  await t.test('names the assertion that broke and keeps the body', () => {
    assert.equal(report.steps[1].assertions![0].detail, 'status expected eq "200", got 500');
    assert.match(report.steps[1].response!.body, /no route|nope/);
  });

  await t.test('skips what came after, with a reason', () => {
    assert.equal(report.steps[2].skipped, 'an earlier step failed');
  });

  await t.test('still runs the teardown, so nothing is left behind', () => {
    assert.equal(report.steps[3].ok, true);
    assert.deepEqual(deleted, ['w7']);
  });
});

test('a request script keeps its token inside the run', async (t) => {
  const report = await run('login-chain', [
    step('login'),
    step('echo', { assert: [{ source: 'body', path: 'auth', op: 'eq', value: 'Bearer w7' }] }),
  ]);

  await t.test('the later step sent the captured token', () => {
    assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
  });

  await t.test('the stored environment never acquires it', async () => {
    // Two runs would otherwise tread on each other, and a CRUD flow would
    // leave an id behind.
    const env = (await environments.list()).find((e) => e.id === ENV)!;
    assert.equal(env.variables.token, undefined);
    assert.equal(env.variables.widget_id, undefined);
  });
});

test('a disabled step is skipped without failing the run', async () => {
  const report = await run('disabled', [
    step('create', { enabled: false }),
    step('boom', { enabled: false }),
  ]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((s) => s.skipped), ['disabled', 'disabled']);
});

// Each of these has to be the first failure in its own run, or the step would
// be skipped as "an earlier step failed" before it is ever looked up.
test('a step can carry its own request instead of pointing at a saved one', async (t) => {
  const report = await run('inline', [
    {
      name: 'create inline',
      mode: 'inline',
      request: {
        method: 'POST',
        url: '{{base_url}}/widgets',
        headers: [{ key: 'X-Probe', value: 'yes', enabled: true }],
        bodyType: 'json',
        body: '{"name":"thing"}',
      },
      extract: [{ var: 'widget_id', from: 'body', path: 'data.id' }],
      assert: [{ source: 'status', op: 'eq', value: '201' }],
    },
    // Typed-in and saved steps share one run: the id captured above reaches
    // the saved request that deletes the row.
    step('remove', { always: true, assert: [{ source: 'status', op: 'eq', value: '200' }] }),
  ]);

  await t.test('sends what was typed and passes', () => {
    assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
    assert.equal(report.steps[0].request!.method, 'POST');
    assert.match(report.steps[0].request!.url, /\/widgets$/);
  });

  await t.test('and the report keeps what went out, not just what came back', () => {
    // The step's stored request has {{vars}} in it and its own body variants;
    // this is the one that was actually posted, headers and auth included.
    const sent = report.steps[0].request!;
    assert.equal(sent.body, '{"name":"thing"}');
    assert.equal(sent.headers['X-Probe'], 'yes');
    assert.equal(sent.headers['Content-Type'], 'application/json');
    assert.equal(sent.bodyTruncated, undefined);
  });

  await t.test('its captured value reaches the later saved step', () => {
    assert.equal(report.vars.widget_id, 'w7');
    assert.deepEqual(deleted, ['w7']);
  });
});

test('an inline step borrows base_url and auth from a collection when given one', async () => {
  const report = await run('inline-with-collection', [
    {
      name: 'echo',
      mode: 'inline',
      collectionId: COL,
      // {{dy_url}} has no folder to expand here, so it is just {{base_url}}.
      request: { method: 'GET', url: '{{dy_url}}/echo' },
      assert: [{ source: 'status', op: 'eq', value: '200' }],
    },
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
});

test('an inline step says for itself what auth it sends', async (t) => {
  // Each runs against /echo, which answers with the Authorization it was handed.
  const echoStep = (name: string, auth: Auth | undefined): StepInput => ({
    name,
    mode: 'inline',
    collectionId: COL_AUTH,
    request: { method: 'GET', url: '{{base_url}}/echo', auth },
  });
  const sentBy = (report: FlowReport, i: number) => JSON.parse(report.steps[i]!.response!.body).auth;

  const report = await run('inline-auth', [
    echoStep('inherits', { type: 'inherit' }),
    echoStep('refuses', { type: 'none' }),
    echoStep('its own bearer', { type: 'bearer', prefix: 'Token', token: '{{tok}}' }),
    // Saved before a step could say anything about auth: it inherited then, and
    // the absence has to keep meaning that.
    echoStep('says nothing', undefined),
  ]);

  await t.test('inherits the collection default when it says nothing else', () => {
    assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
    assert.equal(sentBy(report, 0), 'Bearer secret');
  });

  await t.test('sends none at all when it refuses — what a login needs', () => {
    assert.equal(sentBy(report, 1), null);
  });

  await t.test('sends its own in place of the collection default', () => {
    assert.equal(sentBy(report, 2), 'Token secret');
  });

  await t.test('still inherits when the step predates the setting', () => {
    assert.equal(sentBy(report, 3), 'Bearer secret');
  });
});

test('an inline step with no URL yet says so rather than sending', async () => {
  const report = await run('inline-empty', [
    { name: 'blank', mode: 'inline', request: { method: 'GET', url: '' } },
  ]);
  assert.equal(report.ok, false);
  assert.match(report.steps[0].error!, /no URL yet/);
});

test('a send that never connected still reports the call it tried', async () => {
  // Port 1 on loopback answers nothing. Nothing came back, so the url it built
  // is the whole of what there is to read — and a url that resolved to
  // somewhere unexpected is half the reason a send fails at all.
  const report = await run('unreachable', [
    { name: 'nowhere', mode: 'inline', request: { method: 'POST', url: 'http://127.0.0.1:1/widgets', bodyType: 'json', body: '{"name":"thing"}' } },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.steps[0].request!.url, 'http://127.0.0.1:1/widgets');
  assert.equal(report.steps[0].request!.body, '{"name":"thing"}');
});

test('a step pointing at a deleted request says so', async () => {
  const report = await run('dangling', [
    { name: 'gone', collectionId: COL, requestId: 'does-not-exist' },
  ]);
  assert.equal(report.ok, false);
  assert.match(report.steps[0].error!, /no longer exists/);
});

test('a step with nothing chosen yet says that instead', async () => {
  // Telling someone their request "no longer exists" when they simply have not
  // picked one sends them looking for a deletion that never happened.
  const report = await run('unfilled', [
    { name: 'unfilled', collectionId: null, requestId: null },
  ]);
  assert.equal(report.ok, false);
  assert.match(report.steps[0].error!, /no request selected/);
});

// ---- shell steps ----
// Not everything a feature does shows up in a response. These prove the part
// that matters: a command sees what the requests before it captured, and its
// exit code decides the step.
const sh = (name: string, command: string, extra: Partial<StepInput> = {}): StepInput =>
  ({ name, mode: 'shell', command, ...extra });

test('a shell step runs a command and asserts on what it printed', async (t) => {
  const report = await run('shell-basic', [
    sh('greet', 'echo hello from the shell', {
      assert: [
        { source: 'exit_code', op: 'eq', value: '0' },
        { source: 'stdout', op: 'contains', value: 'hello' },
      ],
    }),
  ]);

  await t.test('passes and keeps the output', () => {
    assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
    assert.equal(report.steps[0].exitCode, 0);
    assert.match(report.steps[0].shell!.stdout, /hello from the shell/);
    assert.equal(report.steps[0].shell!.truncated, false);
  });

  await t.test('reports the command it actually ran', () => {
    assert.equal(report.steps[0].command, 'echo hello from the shell');
    assert.equal(report.steps[0].mode, 'shell');
  });
});

test('a shell step sees what an earlier step captured', async (t) => {
  // The point of the whole feature: the API hands back an id, and a command
  // goes looking for it where the response cannot show it.
  const report = await run('shell-vars', [
    step('create', { extract: [{ var: 'widget_id', from: 'body', path: 'data.id' }] }),
    sh('check the id reached the shell', 'echo "row {{widget_id}} exists"', {
      assert: [{ source: 'stdout', op: 'contains', value: 'row w7 exists' }],
    }),
    step('remove', { always: true }),
  ]);

  await t.test('substitutes the run variable into the command', () => {
    assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
    assert.equal(report.steps[1].command, 'echo "row w7 exists"');
  });

  await t.test('and keeps the line as typed, so the report shows both', () => {
    // What ran is above; this is what is stored on the step and what someone
    // reading the run would go back and edit.
    assert.equal(report.steps[1].commandRaw, 'echo "row {{widget_id}} exists"');
    // Nothing to say when the two are the same — the create step's own report
    // carries no template it never had.
    assert.equal(report.steps[0].commandRaw, undefined);
  });

  await t.test('and can hand a value back the other way', async () => {
    const back = await run('shell-extract', [
      sh('emit', 'echo w42', { extract: [{ var: 'from_shell', from: 'stdout' }] }),
    ]);
    // Trailing newline and all — trimmed, because nobody means the newline.
    assert.equal(back.vars.from_shell.trim(), 'w42');
  });
});

test('a shell step can dig into stdout that is JSON', async () => {
  const report = await run('shell-json', [
    sh('emit json', 'echo \'{"data":{"count":3}}\'', {
      extract: [{ var: 'count', from: 'stdout', path: 'data.count' }],
      assert: [{ source: 'stdout', path: 'data.count', op: 'eq', value: '3' }],
    }),
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
  assert.equal(report.vars.count, '3');
});

test('a non-zero exit fails the step on its own', async (t) => {
  const report = await run('shell-exit', [
    sh('fail', 'echo trouble >&2; exit 3'),
    step('create'),
  ]);

  await t.test('the run fails and says which code', () => {
    assert.equal(report.ok, false);
    assert.equal(report.steps[0].exitCode, 3);
    assert.match(report.steps[0].assertions![0].detail, /exit code 3/);
  });

  await t.test('stderr is kept, being where a failing command explains itself', () => {
    assert.match(report.steps[0].shell!.stderr, /trouble/);
  });

  await t.test('and the chain stops', () => {
    assert.equal(report.steps[1].skipped, 'an earlier step failed');
  });
});

test('asserting on exit_code takes over that judgement', async () => {
  // A step meant to prove a failure says so, and a non-zero exit is then the
  // expected outcome rather than the step's undoing.
  const report = await run('shell-expected-failure', [
    sh('should fail', 'exit 1', {
      assert: [{ source: 'exit_code', op: 'eq', value: '1' }],
    }),
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
});

test('a shell step can check things the rules cannot, with expect()', async () => {
  const report = await run('shell-script', [
    sh('script', 'echo 7', {
      script: 'expect(Number(sh.stdout.trim()) > 5, "more than five")',
    }),
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
  assert.equal(report.steps[0].assertions![0].detail, 'more than five');
});

test('a command that outlives its timeout is killed and reported', async () => {
  const report = await run('shell-timeout', [
    sh('hang', 'sleep 5', { timeout: 300 }),
  ]);
  assert.equal(report.ok, false);
  assert.match(report.steps[0].error!, /did not finish within/);
});

test('a shell step with no command yet says so rather than running', async () => {
  const report = await run('shell-empty', [sh('blank', '   ')]);
  assert.equal(report.ok, false);
  assert.match(report.steps[0].error!, /no command/);
});

test('a shell step resolves environment variables, not just captured ones', async () => {
  const report = await run('shell-env', [
    sh('read the environment', 'echo "{{tok}}"', {
      assert: [{ source: 'stdout', op: 'contains', value: 'secret' }],
    }),
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
});

// ---- a shell test saved in a collection ----
// The same command, filed once and pointed at from every flow that needs it —
// which is the whole reason for keeping one in a collection rather than typing
// it into each step.
test('a step can run a shell test saved in a collection', async (t) => {
  const report = await run('shell-saved', [
    step('row-check', {
      assert: [{ source: 'exit_code', op: 'eq', value: '0' }],
    }),
  ]);

  await t.test('it runs as a shell step, whatever the step called itself', () => {
    assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
    assert.equal(report.steps[0].mode, 'shell');
  });

  await t.test('resolving the environment and the test’s own values', () => {
    assert.match(report.steps[0].command!, /^echo "row w-saved at http:\/\/127\.0\.0\.1:\d+"$/);
  });

  await t.test('and the report keeps what it printed', () => {
    assert.match(report.steps[0].shell!.stdout, /row w-saved/);
  });
});

test('a value captured by the run beats the one saved on the shell test', async () => {
  const report = await run('shell-saved-vars', [
    step('create', { extract: [{ var: 'widget_id', from: 'body', path: 'data.id' }] }),
    step('row-check', {
      assert: [{ source: 'stdout', op: 'contains', value: 'row w7' }],
    }),
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
});

test('a saved shell test takes the step’s directory and shares the run’s shell', async () => {
  const report = await run('shell-saved-cwd', [
    step('row-check', { cwd: os.tmpdir() }),
    sh('still there', 'pwd', { extract: [{ var: 'where', from: 'stdout' }] }),
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
  assert.equal(fs.realpathSync(report.vars.where.trim()), fs.realpathSync(os.tmpdir()));
});

// ---- one shell for the whole run ----
// The point of a session: the commands in a flow are a sequence, and half of
// what makes them one — the directory, the exported variable, the function —
// lives in the shell rather than in the command.
test('shell steps share one shell across the run', async (t) => {
  const report = await run('shell-session', [
    sh('set up', 'cd /tmp && export GREETING=hello && greet() { echo "$GREETING $1"; }'),
    sh('use what the last step left', 'greet world', {
      assert: [{ source: 'stdout', op: 'contains', value: 'hello world' }],
    }),
    sh('and the directory too', 'pwd', {
      extract: [{ var: 'where', from: 'stdout' }],
    }),
  ]);

  await t.test('an export and a function survive into the next step', () => {
    assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
  });

  await t.test('and so does a cd', () => {
    // macOS answers /private/tmp for /tmp, which is the same directory.
    assert.match(report.vars.where.trim(), /^(\/private)?\/tmp$/);
  });
});

test('a flow can ask for a fresh shell per command instead', async () => {
  const flow = await flows.save({
    name: 'shell-isolated',
    shell: { session: false },
    steps: [
      sh('set up', 'export GREETING=hello'),
      sh('look for it', 'echo "[${GREETING}]"', {
        assert: [{ source: 'stdout', op: 'contains', value: '[]' }],
      }),
    ],
  });
  const report = await runFlow(flow, { environmentId: ENV });
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
});

test('the session starts where the flow says', async () => {
  const flow = await flows.save({
    name: 'shell-session-cwd',
    shell: { cwd: os.tmpdir() },
    steps: [sh('where', 'pwd', { extract: [{ var: 'where', from: 'stdout' }] })],
  });
  const report = await runFlow(flow, { environmentId: ENV });
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
  assert.equal(report.vars.where.trim(), fs.realpathSync(os.tmpdir()));
});

test('a step that cds stays there, and one that cannot fails alone', async (t) => {
  const report = await run('shell-session-step-cwd', [
    sh('run somewhere', 'pwd', { cwd: os.tmpdir() }),
    sh('still there', 'pwd', { extract: [{ var: 'where', from: 'stdout' }] }),
  ]);

  await t.test('the step cwd is a cd like any other, so it holds', () => {
    assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
    // Resolved on the way in, because a cd keeps the path it was given —
    // /var/folders on macOS — where spawning into the same directory reports
    // the /private one it is a symlink to. Same place either way.
    assert.equal(fs.realpathSync(report.vars.where.trim()), fs.realpathSync(os.tmpdir()));
  });

  await t.test('a directory that is not there fails the step, not the session', async () => {
    const back = await run('shell-session-bad-cwd', [
      sh('nowhere', 'pwd', { cwd: '/no/such/place/at/all' }),
      sh('after', 'echo still here', {
        always: true,
        assert: [{ source: 'stdout', op: 'contains', value: 'still here' }],
      }),
    ]);
    assert.equal(back.steps[0].ok, false);
    // cd's own complaint, which is the useful half of the failure.
    assert.match(back.steps[0].shell!.stderr, /no such file|not exist|cannot/i);
    assert.equal(back.steps[1].ok, true, JSON.stringify(back.steps[1], null, 2));
    // The session survived a bad cd, so nothing had to be restarted.
    assert.equal(back.steps[1].freshShell, undefined);
  });
});

test('a command that reads stdin cannot eat the commands after it', async () => {
  // The session's stdin is the pipe the next steps arrive on. Without each
  // command being given /dev/null instead, this `cat` would swallow them and
  // the run would hang until the timeout.
  const report = await run('shell-session-stdin', [
    sh('read nothing', 'cat', { timeout: 4000 }),
    sh('after', 'echo survived', {
      assert: [{ source: 'stdout', op: 'contains', value: 'survived' }],
    }),
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
});

test('a step that exits the shell reports its code and the next one starts over', async (t) => {
  const report = await run('shell-session-exit', [
    sh('leave', 'echo bye; exit 4', {
      assert: [{ source: 'exit_code', op: 'eq', value: '4' }],
    }),
    sh('after', 'echo "[${GONE}]"', {
      always: true,
      extract: [{ var: 'out', from: 'stdout' }],
    }),
  ]);

  await t.test('the exit code is the step verdict, output and all', () => {
    assert.equal(report.steps[0].exitCode, 4);
    assert.match(report.steps[0].shell!.stdout, /bye/);
  });

  await t.test('the next step gets a new shell, and says so', () => {
    assert.equal(report.steps[1].ok, true, JSON.stringify(report.steps[1], null, 2));
    assert.equal(report.steps[1].freshShell, true);
    assert.equal(report.vars.out.trim(), '[]');
  });
});

test('a timed-out command takes its session down and the next step goes on', async (t) => {
  const report = await run('shell-session-timeout', [
    sh('hang', 'sleep 5', { timeout: 300 }),
    sh('teardown', 'echo cleaned up', {
      always: true,
      assert: [{ source: 'stdout', op: 'contains', value: 'cleaned up' }],
    }),
  ]);

  await t.test('the step is reported as killed', () => {
    assert.equal(report.steps[0].ok, false);
    assert.match(report.steps[0].error!, /did not finish within/);
  });

  await t.test('and teardown still runs, in a shell of its own', () => {
    assert.equal(report.steps[1].ok, true, JSON.stringify(report.steps[1], null, 2));
    assert.equal(report.steps[1].freshShell, true);
  });
});

test('a session keeps stdout and stderr apart, command by command', async () => {
  const report = await run('shell-session-streams', [
    sh('both', 'echo out1; echo err1 >&2', {
      assert: [
        { source: 'stdout', op: 'contains', value: 'out1' },
        { source: 'stderr', op: 'contains', value: 'err1' },
      ],
    }),
    // Nothing from the step before may leak into this one's streams.
    sh('clean', 'echo out2', { extract: [{ var: 'o', from: 'stdout' }] }),
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
  assert.equal(report.vars.o.trim(), 'out2');
  assert.equal(report.steps[1].shell!.stderr, '');
});

test('a run variable reaches a command in a session the same way', async () => {
  const report = await run('shell-session-vars', [
    step('create', { extract: [{ var: 'widget_id', from: 'body', path: 'data.id' }] }),
    sh('hold it in the shell', 'WIDGET={{widget_id}}'),
    sh('and read it back a step later', 'echo "row $WIDGET"', {
      assert: [{ source: 'stdout', op: 'contains', value: 'row w7' }],
    }),
    step('remove', { always: true }),
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
});
