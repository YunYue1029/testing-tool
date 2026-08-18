// Assembling the request that goes out: which Authorization header ends up on
// it, and which one deliberately does not.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequest } from './runner.ts';
import type { Auth, Collection, HttpRequest } from './types.ts';

// Only the three fields buildRequest reads; the rest of a stored collection
// makes no difference to which header comes out.
const collection = {
  id: 'c1',
  folders: [],
  auth: { type: 'bearer', token: '{{token}}' },
} as unknown as Collection;

const request = (extra: Partial<HttpRequest> = {}): HttpRequest => ({
  id: 'r1', name: 'login', method: 'POST', url: '{{base_url}}/login/', params: [], headers: [], ...extra,
});

const vars = { base_url: 'http://api.test', token: 'stale-token' };

test('the collection default auth', async (t) => {
  await t.test('is added to a request that sets no such header', () => {
    const sent = buildRequest(collection, request(), vars);
    assert.equal(sent.headers.Authorization, 'Bearer stale-token');
  });

  await t.test('stays off a request whose auth is none', () => {
    // A login carrying the token it is about to replace is answered as that
    // token's user, so whatever the new token then encodes is already stale.
    const sent = buildRequest(collection, request({ auth: { type: 'none' } }), vars);
    assert.equal(Object.keys(sent.headers).some((k) => k.toLowerCase() === 'authorization'), false);
  });

  await t.test('stays off a request carrying the older noAuth flag', () => {
    // Saved before a request could carry auth of its own; it still means none.
    const sent = buildRequest(collection, request({ noAuth: true }), vars);
    assert.equal(Object.keys(sent.headers).some((k) => k.toLowerCase() === 'authorization'), false);
  });

  await t.test('gives way to auth the request sets for itself', () => {
    const own: Auth = { type: 'bearer', token: '{{token}}', prefix: 'Token' };
    const sent = buildRequest(collection, request({ auth: own }), vars);
    assert.equal(sent.headers.Authorization, 'Token stale-token');
  });

  await t.test('gives way to a key header the request sets for itself', () => {
    const own: Auth = { type: 'apikey', header: 'X-API-Key', value: '{{token}}' };
    const sent = buildRequest(collection, request({ auth: own }), vars);
    assert.equal(sent.headers['X-API-Key'], 'stale-token');
    assert.equal(Object.keys(sent.headers).some((k) => k.toLowerCase() === 'authorization'), false);
  });

  await t.test('applies to a request that inherits', () => {
    const sent = buildRequest(collection, request({ auth: { type: 'inherit' } }), vars);
    assert.equal(sent.headers.Authorization, 'Bearer stale-token');
  });

  await t.test('never overrides a header the request sets itself', () => {
    const headers = [{ key: 'Authorization', value: 'token {{token}}', enabled: true }];
    assert.equal(
      buildRequest(collection, request({ headers }), vars).headers.Authorization,
      'token stale-token'
    );
    // Sending none refuses the collection's default, not the request's own header.
    assert.equal(
      buildRequest(collection, request({ headers, auth: { type: 'none' } }), vars).headers.Authorization,
      'token stale-token'
    );
  });
});
