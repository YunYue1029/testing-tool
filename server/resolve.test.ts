// What actually gets sent is decided here, so these are the rules worth
// pinning down: folder names becoming URL segments, {{var}} substitution, and
// which header the collection's auth lands in.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  substitute, rowsToObject, collapseSlashes, folderChain, folderPath, dyUrl,
  composeUrl, buildUrl, authHeader, applyCollectionBaseUrl, envVars, requestVars,
} from './resolve.ts';
import type { Auth } from './types.ts';

test('substitute', async (t) => {
  await t.test('replaces known tokens and leaves unknown ones alone', () => {
    assert.equal(substitute('{{a}}/{{b}}', { a: 'x' }), 'x/{{b}}');
  });

  await t.test('tolerates spaces inside the braces', () => {
    assert.equal(substitute('{{ a }}', { a: 'x' }), 'x');
  });

  await t.test('accepts dots and dashes in names', () => {
    assert.equal(substitute('{{a.b-c}}', { 'a.b-c': 'x' }), 'x');
  });

  await t.test('passes null and undefined straight through', () => {
    assert.equal(substitute(null, {}), null);
    assert.equal(substitute(undefined, {}), undefined);
  });

  await t.test('substitutes every occurrence, call after call', () => {
    // VAR_RE is a shared /g regex; if its lastIndex ever survived a call the
    // second one would skip matches.
    for (let i = 0; i < 3; i += 1) {
      assert.equal(substitute('{{a}}{{a}}{{a}}', { a: '1' }), '111');
    }
  });

  await t.test('does not re-expand what a value itself contains', () => {
    assert.equal(substitute('{{a}}', { a: '{{b}}', b: 'x' }), '{{b}}');
  });

  await t.test('ignores inherited object properties', () => {
    assert.equal(substitute('{{toString}}', {}), '{{toString}}');
  });
});

test('requestVars', async (t) => {
  await t.test('collects the values kept on the request', () => {
    const r = { vars: [{ key: 'user_id', value: '42', enabled: true }] };
    assert.deepEqual(requestVars(r), { user_id: '42' });
  });

  await t.test('skips disabled, unnamed and blank rows', () => {
    // A blank value is how a row stops overriding the environment, so it must
    // not go through as an empty string.
    const r = {
      vars: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2', enabled: false },
        { key: 'c', value: '' },
        { key: '', value: '3' },
      ],
    };
    assert.deepEqual(requestVars(r), { a: '1' });
  });

  await t.test('answers with nothing for a request that has no vars', () => {
    assert.deepEqual(requestVars({}), {});
    assert.deepEqual(requestVars(null), {});
  });
});

test('rowsToObject', async (t) => {
  await t.test('keeps enabled rows and substitutes both sides', () => {
    const rows = [{ key: '{{k}}', value: '{{v}}', enabled: true }];
    assert.deepEqual(rowsToObject(rows, { k: 'X-Key', v: 'secret' }), { 'X-Key': 'secret' });
  });

  await t.test('drops disabled rows and the trailing empty row the UI keeps', () => {
    const rows = [
      { key: 'a', value: '1' },
      { key: 'b', value: '2', enabled: false },
      { key: '', value: '', enabled: true },
    ];
    assert.deepEqual(rowsToObject(rows), { a: '1' });
  });

  await t.test('handles a missing rows array', () => {
    assert.deepEqual(rowsToObject(undefined), {});
  });
});

test('collapseSlashes', async (t) => {
  await t.test('collapses doubled slashes in the path', () => {
    assert.equal(collapseSlashes('http://a.com//users'), 'http://a.com/users');
    assert.equal(collapseSlashes('http://a.com/a///b'), 'http://a.com/a/b');
  });

  await t.test('leaves the scheme separator intact', () => {
    assert.equal(collapseSlashes('https://a.com/x'), 'https://a.com/x');
  });
});

test('folderChain / folderPath', async (t) => {
  const folders = [
    { id: 'api', name: 'api', parentId: null },
    { id: 'v1', name: 'v1', parentId: 'api' },
    { id: 'users', name: 'users', parentId: 'v1' },
  ];

  await t.test('returns the chain root-first', () => {
    assert.deepEqual(folderChain(folders, 'users').map((f) => f.id), ['api', 'v1', 'users']);
  });

  await t.test('is empty at the collection root', () => {
    assert.deepEqual(folderChain(folders, null), []);
  });

  await t.test('joins names for display', () => {
    assert.equal(folderPath(folders, 'users'), 'api / v1 / users');
    assert.equal(folderPath(folders, null), '');
  });

  await t.test('terminates on a parent cycle instead of hanging', () => {
    const cyclic = [
      { id: 'a', name: 'a', parentId: 'b' },
      { id: 'b', name: 'b', parentId: 'a' },
    ];
    assert.deepEqual(folderChain(cyclic, 'a').map((f) => f.id), ['b', 'a']);
  });

  await t.test('stops at a parent that no longer exists', () => {
    const orphan = [{ id: 'a', name: 'a', parentId: 'gone' }];
    assert.deepEqual(folderChain(orphan, 'a').map((f) => f.id), ['a']);
  });
});

test('dyUrl', async (t) => {
  const folders = [
    { id: 'api', name: 'api', parentId: null },
    { id: 'v1', name: 'v1', parentId: 'api' },
  ];

  await t.test('accumulates folder names as path segments', () => {
    assert.equal(dyUrl(folders, 'v1'), '{{base_url}}/api/v1');
  });

  await t.test('is just base_url at the collection root', () => {
    assert.equal(dyUrl(folders, null), '{{base_url}}');
  });

  await t.test('trims stray slashes and skips blank names', () => {
    const messy = [
      { id: 'a', name: '/api/', parentId: null },
      { id: 'b', name: '   ', parentId: 'a' },
      { id: 'c', name: 'v1', parentId: 'b' },
    ];
    assert.equal(dyUrl(messy, 'c'), '{{base_url}}/api/v1');
  });
});

test('composeUrl', async (t) => {
  const folders = [{ id: 'auth', name: 'auth', parentId: null }];

  await t.test('expands the token to base_url + folder path', () => {
    assert.equal(composeUrl(folders, 'auth', '{{dy_url}}/login/'), '{{base_url}}/auth/login/');
  });

  await t.test('leaves a url without the token untouched', () => {
    // Folders only affect a request that opts in.
    assert.equal(composeUrl(folders, 'auth', 'https://example.com/x'), 'https://example.com/x');
    assert.equal(composeUrl(folders, 'auth', undefined), undefined);
  });
});

test('buildUrl', async (t) => {
  await t.test('resolves variables and collapses the seam', () => {
    const vars = { base_url: 'http://h:8000/', id: '7' };
    assert.equal(buildUrl('{{base_url}}/users/{{id}}', [], vars), 'http://h:8000/users/7');
  });

  await t.test('appends enabled params, url-encoded', () => {
    const rows = [{ key: 'q', value: 'a b&c' }, { key: 'skip', value: '1', enabled: false }];
    assert.equal(buildUrl('http://h/s', rows, {}), 'http://h/s?q=a%20b%26c');
  });

  await t.test('joins with & when the url already has a query string', () => {
    assert.equal(buildUrl('http://h/s?a=1', [{ key: 'b', value: '2' }], {}), 'http://h/s?a=1&b=2');
  });

  await t.test('adds nothing when no param row is filled in', () => {
    assert.equal(buildUrl('http://h/s', [{ key: '', value: '' }], {}), 'http://h/s');
  });
});

test('authHeader', async (t) => {
  await t.test('is off when unset or empty', () => {
    assert.equal(authHeader(''), null);
    assert.equal(authHeader(null), null);
    assert.equal(authHeader({ type: 'bearer', token: '  ' }), null);
    assert.equal(authHeader({ type: 'apikey', header: 'X-Key', value: ' ' }), null);
    // Deliberately not one of ours: an unknown type must read as off.
    assert.equal(authHeader({ type: 'something-else' } as unknown as Auth), null);
  });

  await t.test('accepts a legacy raw string as the Authorization value', () => {
    assert.deepEqual(authHeader('Token abc'), { name: 'Authorization', value: 'Token abc' });
  });

  await t.test('defaults the bearer prefix but lets it be dropped', () => {
    assert.deepEqual(
      authHeader({ type: 'bearer', token: '{{token}}' }),
      { name: 'Authorization', value: 'Bearer {{token}}' },
    );
    assert.deepEqual(
      authHeader({ type: 'bearer', token: '{{token}}', prefix: '' }),
      { name: 'Authorization', value: '{{token}}' },
    );
  });

  await t.test('puts an api key in its own header', () => {
    assert.deepEqual(
      authHeader({ type: 'apikey', header: 'X-Api-Key', value: '{{key}}' }),
      { name: 'X-Api-Key', value: '{{key}}' },
    );
  });
});

test('applyCollectionBaseUrl', async (t) => {
  await t.test('overrides base_url with the collection value', () => {
    const out = applyCollectionBaseUrl({ base_url: 'http://env' }, { baseUrl: 'http://col' });
    assert.equal(out.base_url, 'http://col');
  });

  await t.test('resolves {{vars}} inside the collection value', () => {
    const out = applyCollectionBaseUrl(
      { base_url: 'http://env', host: 'http://svc:8001' },
      { baseUrl: '{{host}}' },
    );
    assert.equal(out.base_url, 'http://svc:8001');
  });

  await t.test('leaves the vars alone when the collection sets nothing', () => {
    const vars = { base_url: 'http://env' };
    assert.equal(applyCollectionBaseUrl(vars, { baseUrl: '   ' }), vars);
    assert.equal(applyCollectionBaseUrl(vars, null), vars);
  });
});

test('envVars', async (t) => {
  await t.test('excludes keys listed as disabled', () => {
    const env = { variables: { a: '1', b: '2' }, disabled: ['b'] };
    assert.deepEqual(envVars(env), { a: '1' });
  });

  await t.test('is empty without an environment', () => {
    assert.deepEqual(envVars(null), {});
  });
});
