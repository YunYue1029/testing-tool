// The pure parts of a flow run: reading a value out of a response and deciding
// whether an assertion passed. runFlow itself is covered in flow.run.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';

import { valueAt, readFrom, evalAssertion, pristineAssertion } from './flow.ts';
import type { Assertion, HttpResponse, Vars } from './types.ts';

const response = {
  status: 201,
  statusText: 'Created',
  time: 12,
  headers: { 'content-type': 'application/json', location: '/widgets/7' },
  cookies: { session: 'abc' },
  body: JSON.stringify({ data: { id: 7, items: [{ id: 'first' }] }, ok: true, note: null }),
  // Only what these tests read; size and bodyEncoding play no part.
} as unknown as HttpResponse;

test('valueAt', async (t) => {
  await t.test('walks a dotted path, array indexes included', () => {
    const obj = { data: { items: [{ id: 'first' }] } };
    assert.equal(valueAt(obj, 'data.items.0.id'), 'first');
  });

  await t.test('returns the whole object for an empty path', () => {
    const obj = { a: 1 };
    assert.equal(valueAt(obj, ''), obj);
  });

  await t.test('gives undefined rather than throwing on a dead end', () => {
    assert.equal(valueAt({ a: null }, 'a.b.c'), undefined);
    assert.equal(valueAt(undefined, 'a'), undefined);
  });
});

test('readFrom', async (t) => {
  await t.test('reads the status and elapsed time', () => {
    assert.equal(readFrom(response, 'status'), 201);
    assert.equal(readFrom(response, 'time'), 12);
  });

  await t.test('looks headers up case-insensitively', () => {
    // Header names arrive lowercased; an assertion typed as "Location" must
    // still find it.
    assert.equal(readFrom(response, 'header', 'Location'), '/widgets/7');
  });

  await t.test('reads a cookie by name', () => {
    assert.equal(readFrom(response, 'cookie', 'session'), 'abc');
  });

  await t.test('reads a path out of a JSON body, defaulting to body', () => {
    assert.equal(readFrom(response, 'body', 'data.id'), 7);
    assert.equal(readFrom(response, undefined, 'data.items.0.id'), 'first');
  });

  await t.test('hands back the raw text when the body is not JSON', () => {
    // So `contains` and `matches` still mean something against an HTML error page.
    const plain = { ...response, body: 'not json at all' };
    assert.equal(readFrom(plain, 'body', ''), 'not json at all');
    assert.equal(readFrom(plain, 'body', 'data.id'), undefined);
  });
});

test('evalAssertion', async (t) => {
  const check = (a: Assertion, vars: Vars = {}) => evalAssertion(response, a, vars);

  await t.test('compares loosely, so "201" matches 201', () => {
    // The body gives a number, a form gives a string.
    assert.equal(check({ source: 'status', op: 'eq', value: '201' }).ok, true);
    assert.equal(check({ source: 'body', path: 'data.id', op: 'eq', value: '7' }).ok, true);
  });

  await t.test('resolves {{vars}} in the expected value', () => {
    const r = check({ source: 'body', path: 'data.id', op: 'eq', value: '{{wanted}}' }, { wanted: '7' });
    assert.equal(r.ok, true);
  });

  await t.test('defaults to eq when no operator is given', () => {
    assert.equal(check({ source: 'status', value: 201 }).ok, true);
  });

  await t.test('exists / missing treat null as absent', () => {
    assert.equal(check({ source: 'body', path: 'data.id', op: 'exists' }).ok, true);
    assert.equal(check({ source: 'body', path: 'note', op: 'exists' }).ok, false);
    assert.equal(check({ source: 'body', path: 'nope', op: 'missing' }).ok, true);
  });

  await t.test('supports neq, contains, lt and gt', () => {
    assert.equal(check({ source: 'status', op: 'neq', value: '404' }).ok, true);
    assert.equal(check({ source: 'header', path: 'content-type', op: 'contains', value: 'json' }).ok, true);
    assert.equal(check({ source: 'time', op: 'lt', value: '1000' }).ok, true);
    assert.equal(check({ source: 'time', op: 'gt', value: '1000' }).ok, false);
  });

  await t.test('matches applies a regex', () => {
    assert.equal(check({ source: 'header', path: 'location', op: 'matches', value: '^/widgets/\\d+$' }).ok, true);
  });

  await t.test('reports an unparseable regex instead of throwing', () => {
    const r = check({ source: 'header', path: 'location', op: 'matches', value: '[' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /invalid regex/);
  });

  await t.test('says what it wanted and what it got when it fails', () => {
    const r = check({ source: 'body', path: 'data.id', op: 'eq', value: '9' });
    assert.equal(r.ok, false);
    assert.equal(r.detail, 'body data.id expected eq "9", got 7');
  });

  await t.test('names the missing field when exists fails', () => {
    const r = check({ source: 'body', path: 'nope', op: 'exists' });
    assert.equal(r.detail, 'body nope expected to exists, got undefined');
  });
});

test('pristineAssertion', async (t) => {
  await t.test('spots the blank row the editor used to save', () => {
    // No path, no value, and an operator that needs one — it can only ever
    // fail, so it must not count as a check.
    assert.equal(pristineAssertion({ source: 'status', op: 'eq', value: '' }), true);
    assert.equal(pristineAssertion({ source: 'body' }), true);
  });

  await t.test('keeps a row that names a field, even with an empty expectation', () => {
    // `body data.name eq ""` is a real check: the field must be empty.
    assert.equal(pristineAssertion({ source: 'body', path: 'data.name', op: 'eq', value: '' }), false);
  });

  await t.test('keeps exists / missing, which need no value', () => {
    assert.equal(pristineAssertion({ source: 'body', op: 'exists' }), false);
    assert.equal(pristineAssertion({ source: 'body', op: 'missing' }), false);
  });

  await t.test('keeps a row with a value, including a falsy one', () => {
    assert.equal(pristineAssertion({ source: 'status', op: 'eq', value: '200' }), false);
    assert.equal(pristineAssertion({ source: 'status', op: 'eq', value: 0 }), false);
  });
});
