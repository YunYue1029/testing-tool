import test from 'node:test';
import assert from 'node:assert/strict';

import { convertPostmanCollection, convertPostmanEnvironment } from './postman.ts';
import type { ImportedCollection, PmCollection, PmItem } from './postman.ts';
import type { FormFileRow, HttpRequest } from './types.ts';

// A minimal v2.x export. `folder(...)` nests, `req(...)` is a leaf.
const folder = (name: string, ...items: PmItem[]): PmItem => ({ name, item: items });
const req = (name: string, url: string, extra: Record<string, unknown> = {}): PmItem =>
  ({ name, request: { method: 'GET', url, ...extra } });
const exportOf = (items: PmItem[], extra: Partial<PmCollection> = {}): PmCollection =>
  ({ info: { name: 'My API' }, item: items, ...extra });

const convert = (pm: PmCollection): ImportedCollection => convertPostmanCollection(pm)[0]!;
const byName = (col: ImportedCollection, name: string): HttpRequest =>
  col.requests.find((r) => r.name === name)!;
const pathOf = (col: ImportedCollection, id: string | null | undefined): string => {
  const names: string[] = [];
  let cur = col.folders.find((f) => f.id === id);
  while (cur) {
    names.unshift(cur.name);
    const parentId: string | null = cur.parentId;
    cur = parentId ? col.folders.find((f) => f.id === parentId) : undefined;
  }
  return names.join('/');
};

test('one collection per export', async (t) => {
  await t.test('takes its name from info', () => {
    assert.equal(convert(exportOf([])).name, 'My API');
    assert.equal(convert({ item: [] }).name, 'Imported');
  });

  await t.test('does not split top-level folders into separate collections', () => {
    // They are folders now, which is what the app models.
    const cols = convertPostmanCollection(exportOf([
      folder('Auth', req('login', 'https://h/auth/login')),
      folder('Users', req('list', 'https://h/users')),
    ]));
    assert.equal(cols.length, 1);
    assert.equal(cols[0]!.requests.length, 2);
  });
});

test('folder tree', async (t) => {
  const col = convert(exportOf([
    folder('api', folder('v1', req('list users', 'https://h/api/v1/users'))),
    req('health', 'https://h/health'),
  ]));

  await t.test('mirrors Postman nesting through parentId', () => {
    assert.equal(col.folders.length, 2);
    const inner = col.folders.find((f) => f.name === 'v1');
    assert.equal(pathOf(col, inner!.id), 'api/v1');
  });

  await t.test('files each request in its folder', () => {
    assert.equal(pathOf(col, byName(col, 'list users').folderId), 'api/v1');
  });

  await t.test('leaves a root-level request unfiled', () => {
    assert.equal(byName(col, 'health').folderId, null);
  });

  await t.test('stops folding the path into the request name', () => {
    // It used to arrive as "api / v1 / list users".
    assert.equal(byName(col, 'list users').name, 'list users');
  });
});

test('base_url', async (t) => {
  await t.test('lifts the shared host off every request', () => {
    const col = convert(exportOf([
      req('a', 'https://api.example.com/users'),
      req('b', 'https://api.example.com/orders'),
    ]));
    assert.equal(col.baseUrl, 'https://api.example.com');
    assert.deepEqual(col.requests.map((r) => r.url), ['{{base_url}}/users', '{{base_url}}/orders']);
  });

  await t.test('lifts a Postman {{variable}} host the same way', () => {
    // A collection base_url may itself contain {{vars}}, so the imported
    // Postman environment still steers it.
    const col = convert(exportOf([req('a', '{{baseUrl}}/users')]));
    assert.equal(col.baseUrl, '{{baseUrl}}');
    assert.equal(byName(col, 'a').url, '{{base_url}}/users');
  });

  await t.test('picks the host most requests share', () => {
    const col = convert(exportOf([
      req('a', 'https://api.example.com/users'),
      req('b', 'https://api.example.com/orders'),
      req('c', 'https://other.example.com/thing'),
    ]));
    assert.equal(col.baseUrl, 'https://api.example.com');
  });

  await t.test('leaves a request on another host spelled out in full', () => {
    const col = convert(exportOf([
      req('a', 'https://api.example.com/users'),
      req('b', 'https://api.example.com/orders'),
      req('c', 'https://other.example.com/thing'),
    ]));
    assert.equal(byName(col, 'c').url, 'https://other.example.com/thing');
  });

  await t.test('copes with an export that has no requests', () => {
    const col = convert(exportOf([]));
    assert.equal(col.baseUrl, '');
  });
});

test('{{dy_url}} rewriting', async (t) => {
  await t.test('applies when the folder names are the leading path segments', () => {
    const col = convert(exportOf([
      folder('api', folder('v1', req('list', 'https://h/api/v1/users'))),
    ]));
    assert.equal(byName(col, 'list').url, '{{dy_url}}/users');
  });

  await t.test('keeps a trailing slash', () => {
    const col = convert(exportOf([folder('users', req('list', 'https://h/users/'))]));
    assert.equal(byName(col, 'list').url, '{{dy_url}}/');
  });

  await t.test('handles a url that is exactly the folder path', () => {
    const col = convert(exportOf([folder('users', req('list', 'https://h/users'))]));
    assert.equal(byName(col, 'list').url, '{{dy_url}}');
  });

  await t.test('leaves prose folder names alone', () => {
    // "User Management" is a grouping, not a route — rewriting it would
    // produce /User%20Management/users.
    const col = convert(exportOf([
      folder('User Management', req('list', 'https://h/api/users')),
    ]));
    assert.equal(byName(col, 'list').url, '{{base_url}}/api/users');
  });

  await t.test('does not rewrite on a partial segment match', () => {
    const col = convert(exportOf([folder('user', req('list', 'https://h/users'))]));
    assert.equal(byName(col, 'list').url, '{{base_url}}/users');
  });

  await t.test('does not rewrite a root-level request', () => {
    const col = convert(exportOf([req('health', 'https://h/health')]));
    assert.equal(byName(col, 'health').url, '{{base_url}}/health');
  });
});

test('request details', async (t) => {
  await t.test('moves the query string into param rows', () => {
    const col = convert(exportOf([{
      name: 'search',
      request: { method: 'GET', url: { raw: 'https://h/s?q=a&page=2', query: [{ key: 'q', value: 'a' }, { key: 'page', value: '2', disabled: true }] } },
    }]));
    const r = byName(col, 'search');
    assert.equal(r.url, '{{base_url}}/s');
    assert.deepEqual(r.params!.slice(0, 2), [
      { key: 'q', value: 'a', enabled: true },
      { key: 'page', value: '2', enabled: false },
    ]);
  });

  await t.test('reads the query out of the url when there is no query array', () => {
    // v2.0 exports, and any item whose url is a plain string, only have `raw`.
    const col = convert(exportOf([req('search', 'https://h/s?q=hello%20there&page=2')]));
    const r = byName(col, 'search');
    assert.equal(r.url, '{{base_url}}/s');
    assert.deepEqual(r.params!.slice(0, 2), [
      { key: 'q', value: 'hello there', enabled: true },
      { key: 'page', value: '2', enabled: true },
    ]);
  });

  await t.test('keeps a {{var}} in the query intact', () => {
    const col = convert(exportOf([req('one', 'https://h/s?id={{user_id}}')]));
    assert.deepEqual(byName(col, 'one').params![0], { key: 'id', value: '{{user_id}}', enabled: true });
  });

  await t.test('detects a JSON raw body', () => {
    const col = convert(exportOf([req('create', 'https://h/x', {
      method: 'POST', body: { mode: 'raw', raw: '{"a":1}' },
    })]));
    const r = byName(col, 'create');
    assert.equal(r.bodyType, 'json');
    assert.equal(r.bodies![0]!.content, '{"a":1}');
    assert.equal(r.activeBodyId, r.bodies![0]!.id);
  });

  await t.test('turns urlencoded into a text body with the right header', () => {
    const col = convert(exportOf([req('form', 'https://h/x', {
      method: 'POST', body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }] },
    })]));
    const r = byName(col, 'form');
    assert.equal(r.bodyType, 'text');
    assert.equal(r.bodies![0]!.content, 'a=1');
    assert.ok(r.headers!.some((h) => h.key === 'Content-Type' && h.value === 'application/x-www-form-urlencoded'));
  });

  await t.test('keeps a file field as an empty row with the original path as a hint', () => {
    const col = convert(exportOf([req('upload', 'https://h/x', {
      method: 'POST', body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: '/home/me/a.png' }] },
    })]));
    const r = byName(col, 'upload');
    assert.equal(r.bodyType, 'form');
    assert.equal((r.form![0] as FormFileRow).fileHint, '/home/me/a.png');
  });

  await t.test('accepts a request given as a bare url string', () => {
    const col = convert(exportOf([{ name: 'plain', request: 'https://h/ping' }]));
    assert.equal(byName(col, 'plain').method, 'GET');
    assert.equal(byName(col, 'plain').url, '{{base_url}}/ping');
  });
});

test('collection auth', async (t) => {
  await t.test('maps bearer', () => {
    const col = convert(exportOf([], { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] } }));
    assert.deepEqual(col.auth, { type: 'bearer', token: '{{token}}' });
  });

  await t.test('maps an api key header', () => {
    const col = convert(exportOf([], {
      auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key' }, { key: 'value', value: '{{k}}' }] },
    }));
    assert.deepEqual(col.auth, { type: 'apikey', header: 'X-Api-Key', value: '{{k}}' });
  });

  await t.test('leaves auth off rather than half-applying what we cannot express', () => {
    // An api key in the query string, and oauth2, have no equivalent here.
    const inQuery = convert(exportOf([], {
      auth: { type: 'apikey', apikey: [{ key: 'key', value: 'k' }, { key: 'value', value: 'v' }, { key: 'in', value: 'query' }] },
    }));
    assert.equal(inQuery.auth, '');
    assert.equal(convert(exportOf([], { auth: { type: 'oauth2' } })).auth, '');
    assert.equal(convert(exportOf([])).auth, '');
  });
});

test('environment export', async (t) => {
  await t.test('becomes variables, with unchecked keys disabled', () => {
    const env = convertPostmanEnvironment({
      name: 'Staging',
      values: [
        { key: 'host', value: 'https://staging' },
        { key: 'old', value: 'x', enabled: false },
        { key: '', value: 'ignored' },
      ],
    });
    assert.equal(env.name, 'Staging');
    assert.deepEqual(env.variables, { host: 'https://staging', old: 'x' });
    assert.deepEqual(env.disabled, ['old']);
  });
});
