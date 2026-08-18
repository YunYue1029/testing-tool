#!/usr/bin/env node
// MCP server for the api-test tool. Talks to the api-test HTTP backend and
// exposes collections / environments / send as MCP tools.
//
// Two transports:
//   - stdio (default): the MCP client spawns this process per session.
//   - Streamable HTTP: set MCP_HTTP_PORT to run as a long-lived service that
//     clients reach by URL (http://host:PORT/mcp). This is what `npm run dev`
//     starts, so any project's .mcp.json can point at the one URL.
//
// NOTE (stdio mode): stdout is the protocol channel — never console.log to it.
//       Use console.error (stderr) for diagnostics.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { api } from './api.ts';
import type {
  Auth, AuthType, Folder, HttpRequest, HttpResponse, InlineRequest, Row,
  SavedRequest, ShellRequest, ShellResponse,
} from '../server/types.ts';

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- display helpers ----
// Nothing here decides what gets sent. Every tool that sends something posts to
// the backend's /api/run, so server/resolve.js is the only place
// {{vars}}, {{dy_url}} and auth are worked out. This file used to carry a copy
// of those rules, which is exactly how it ended up sending something different
// from the app.

// "Parent / Child" name path for a folder id (empty at the collection root).
function folderPath(folders: Folder[] | undefined, folderId: string | null | undefined): string {
  const byId = new Map((folders || []).map((f) => [f.id, f]));
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = folderId ? byId.get(folderId) : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return names.join(' / ');
}

// Stored rows as {key: value}, {{vars}} left as they are — this reports what is
// saved, not what would be sent.
function rowsToPlainObject(rows: Row[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows || []) {
    if (r.enabled === false || !r.key) continue;
    out[r.key] = r.value;
  }
  return out;
}

// Which auth a stored request runs under. `noAuth: true` is the older spelling
// of type 'none', on requests saved before a request could carry its own.
function authType(request: SavedRequest | null | undefined): AuthType {
  const type = request && 'auth' in request && request.auth && request.auth.type;
  if (type) return type;
  return request && 'noAuth' in request && request.noAuth ? 'none' : 'inherit';
}

// The row shape the app stores. `trailingBlank` adds the empty row the UI keeps
// at the bottom of an editable list — wanted for a request being saved,
// pointless for a one-off send.
function toRows(
  obj: Record<string, string> | undefined,
  { trailingBlank = false }: { trailingBlank?: boolean } = {},
): Row[] {
  const rows = Object.entries(obj || {}).map(([key, value]) => ({ key, value, enabled: true }));
  if (trailingBlank) rows.push({ key: '', value: '', enabled: true });
  return rows;
}

// A flow step's own request, from the flat shape a tool call gives to the one
// the app stores. Headers and params arrive as objects here — a caller writing
// {"Authorization": "Bearer {{token}}"} shouldn't have to spell out rows.
// The flat shape a tool call gives, as the app stores it.
interface McpInline {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body_type?: 'none' | 'json' | 'text';
  body?: string;
  auth?: Auth;
}

function inlineFromMcp(inline: McpInline): InlineRequest {
  return {
    method: (inline.method || 'GET').toUpperCase(),
    url: inline.url,
    headers: toRows(inline.headers),
    params: toRows(inline.params),
    bodyType: inline.body_type || (inline.body ? 'json' : 'none'),
    body: inline.body || '',
    auth: inline.auth || { type: 'inherit' },
  };
}

// ---- result helpers ----
function ok(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

// ---- environment helpers ----
async function findEnv(ref: string | undefined) {
  if (!ref) return null;
  const envs = await api.listEnvironments();
  return envs.find((e) => e.id === ref || e.name === ref) || null;
}

// The backend resolves the environment itself, but its "not found" carries no
// list of what does exist, which is the only thing that helps from here.
async function assertEnv(ref: string | undefined) {
  if (!ref || await findEnv(ref)) return;
  const envs = await api.listEnvironments();
  const names = envs.map((e) => e.name).join(', ') || '(none)';
  throw new Error(`Environment "${ref}" not found. Available: ${names}`);
}

function isShellResponse(r: HttpResponse | ShellResponse): r is ShellResponse {
  return 'kind' in r && r.kind === 'shell';
}

// Shape a backend response for tool output.
function shapeResponse(r: HttpResponse | ShellResponse) {
  // A shell test ran a command instead of sending anything: its verdict is the
  // exit code, and what it has to say is on the two streams. Reporting it in a
  // response's shape would mean calling an exit code a status.
  if (isShellResponse(r)) {
    return {
      exit_code: r.exitCode,
      time_ms: r.time,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  }
  return {
    status: r.status,
    status_text: r.statusText,
    time_ms: r.time,
    size_bytes: r.size,
    headers: r.headers,
    // {name: value} parsed from Set-Cookie — store needed ones (e.g. an
    // HttpOnly refresh token) with set_env_var for later requests.
    cookies: r.cookies || {},
    // Binary responses (images, PDFs, zips) arrive base64-encoded rather than
    // as mangled UTF-8; say so instead of letting it look like garbled text.
    ...(r.bodyEncoding === 'base64' ? { body_encoding: 'base64' } : {}),
    body: r.body,
  };
}

// Usage conventions, delivered to every client via the MCP `instructions`
// field on initialize — so no client-side setup or docs are needed.
const INSTRUCTIONS = `api-test: a self-hosted Postman replacement for testing an API/CRUD backend
under development. Requests are organised as collection -> folders -> requests.

{{dy_url}} — dynamic URLs from folder structure (use this well):
- {{dy_url}} expands to {{base_url}} + the request's folder path. Folder
  names ARE URL path segments; nesting accumulates:
    folder "auth",    url "{{dy_url}}/login/"       -> <base>/auth/login/
    folder "api/v1",  url "{{dy_url}}/users"         -> <base>/api/v1/users
    request at collection root, "{{dy_url}}/health"  -> <base>/health
- Why: the folder tree mirrors the API's route tree. Rename a folder and
  every request inside follows the new route; switch base_url (environment
  or the built-in default) and the whole collection points at another host.
  No per-request URL edits, ever.
- Design folders after route prefixes, one folder per resource/prefix:
    routes /users, /users/:id            -> folder "users"
    routes /orders/:id/items             -> folder "orders" (url {{dy_url}}/{{order_id}}/items)
    versioned API /api/v1/...            -> nested folders "api" > "v1"
  Inside a folder, the url holds ONLY what comes after the folder path —
  typically "{{dy_url}}/", "{{dy_url}}/{{id}}/", or a short sub-path.
- NEVER repeat the folder name in the url: in folder "auth",
  "{{dy_url}}/auth/login/" would produce /auth/auth/login/. If a saved url
  duplicates its folder path, that is a bug — strip the duplicate.
- Path params are just {{vars}}: "{{dy_url}}/{{user_id}}/" resolves user_id
  from the request's own vars first, then the environment. Query strings go in
  save_request's params, not the url.
- Skip {{dy_url}} only for one-off external calls: a full http(s):// url is
  sent verbatim (no base_url, no folder path).
- base_url resolves per request, most specific wins:
    1. the collection's own base_url (set_collection_base_url / create_collection)
    2. the environment's base_url variable
    3. built-in default http://localhost:8000
  Testing several services/containers at once? One collection per service,
  each with its own base_url (e.g. :8001, :8002) — then {{dy_url}} never
  collides across services. A collection base_url may contain {{vars}}
  (e.g. {{oivision_host}}) so environments can still switch stage per service.
  Do not hardcode hosts in saved requests.

Cataloguing an API's endpoints (do this once per route, not per test):
1. list_collections -> find or create_collection.
2. get_collection -> folders (folder_id, path) + endpoints; check structure first.
3. create_folder (nest via parent_folder_id) — name folders after routes.
4. save_request with request.folder_id and a {{dy_url}}/... url.
5. run_saved_request (pass environment when vars/token needed).

Testing goes through flows instead, with the steps typed into the flow — see
below. Reaching for save_request while writing a test is the usual way a
collection fills up with things that are not endpoints.

Flows — testing a whole feature, not one endpoint:
- A flow chains steps: login -> create -> read -> update -> delete. Steps pass
  values on with extract ({var:"user_id", from:"body", path:"data.id"}), which
  later steps use as {{user_id}}.
- WHERE A STEP'S REQUEST LIVES. Default to mode:"inline" — the request typed
  into the step. A step that exists only to exercise a case is a test, and a
  test belongs in the flow that needs it:
    an invalid payload, a restore-the-original call, a one-off probe, the same
    route again with different data, anything named after what it proves
    ("set timezone to X", "reject a bad value", "restore").
  save_request is for the API's own endpoints: one entry per route, the call
  someone would want to send by hand later. Before saving, ask whether the
  collection already has that route — if it does, this is a case of it, so
  inline it instead. A collection is the catalogue of what the API offers; it
  stops being readable the moment test cases are filed alongside routes, and
  nobody can find the real endpoint among nine variants of it.
- After building or changing a resource's endpoints, save_flow a CRUD flow for
  it and run_flow — that is what proves the routes work together, which running
  each request alone does not.
- Mark the delete step always:true so a failed run still cleans up after
  itself. Run variables never touch the stored environment.
- A step can run a shell command instead of a request (mode:"shell"), which is
  how a flow checks what no response can show — that the row is really in the
  database, the file was written, the job ran. {{vars}} reach the command, so
  it can look up exactly what the previous step created.
- NEVER use mode:"shell" to call the API itself (curl/wget/httpie against the
  route under test). If a saved request already exists for that route, use
  it (or a plain mode:"request" step); if it doesn't exist yet, save_request
  it first, then call that. Reaching for curl instead of the existing request
  bypasses the collection's auth, vars, and dy_url — and skips the very
  cataloguing this MCP exists to keep up to date. Shell is only for what a
  response body can't prove: a database row, a file on disk, a log line, a
  job's exit state.
- Every command in a flow runs in the same shell, so a cd or an export in one
  step is still in force in the next. Write a sequence as several steps, each
  with its own assertions, rather than one command strung together with &&.
- A command worth running more than once belongs in a collection, not typed
  into each flow: save_shell_test files it beside the endpoints it checks, and
  a step points at it with collection_id + request_id like any saved request.
  run_saved_request runs one on its own, answering with exit_code/stdout/stderr.
- Flows are filed in their own folder tree (list_flows reports it,
  create_flow_folder adds to it, save_flow's folder_id files a flow in one).
  These folders are organisation only — name them after the feature under test,
  not after routes; they have nothing to do with {{dy_url}}.

Where a {{var}} should live (most specific wins at run time):
- request vars (save_request request.vars) — an id only this call cares about,
  e.g. the {{user_id}} of a fetch-one. Keeps single-use ids out of the
  environment, where they bury the handful that are genuinely shared. Clear a
  value (or the whole object) to fall back to the environment again.
- environment (set_env_var) — shared across requests: base_url, token, a
  fixture id every call in a suite uses.

Post-response scripts (save_request request.script):
- JS run against the response, with env.set(name, value) to store what it
  produced. The canonical use is a login request:
    env.set('token', res.json().access_token)
  so every later request resolves {{token}} through the collection's auth.
- Available: res.status, res.statusText, res.headers, res.cookies (parsed from
  Set-Cookie — that is how an HttpOnly refresh token is captured), res.body,
  res.json(). env.get(name) reads a variable back.
- A plain run writes env.set values into the active environment; inside a flow
  they stay run-scoped and the stored environment is untouched.

Auth & environments:
- Collections may define a default auth (e.g. Bearer {{token}}) applied to
  requests lacking that header — do not add Authorization headers manually.
  A request inherits it unless its own auth says otherwise (see save_request).
- A login must set auth: {"type":"none"}. Otherwise it goes out carrying the
  token it exists to replace, and a backend that reads anything from the token it was
  handed (a timezone claim, a tenant) answers as that stale token's user — the
  new token then carries the old answer, and the first request after a change
  still reflects the value from before it.
- On 401: run the login request first (its script saves the token via
  env.set), or store tokens with set_env_var.

Rules:
- Write one at a time: never issue parallel save_request/create_folder calls
  against the same collection (whole-document writes can lose updates).
- Multipart/file bodies can't be created or edited here (body types: none,
  json, text) — a request already using one keeps it through save_request;
  its fields are edited in the app.
- Prefer get_collection / search_requests before get_request (token economy).`;

// Build a fresh MCP server with all tools registered. A factory (rather than a
// singleton) so HTTP mode can create one server per session.
function createServer() {
  const server = new McpServer({ name: 'api-test', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  // Register a tool with uniform error handling. The handler's argument type
  // is inferred from the tool's own `inputSchema`, so the zod shape below each
  // tool is the single definition of what it takes.
  const tool = <S extends ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ): void => {
    server.registerTool(name, config, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await handler(args || ({} as z.infer<z.ZodObject<S>>)));
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message || String(err) }],
          isError: true,
        };
      }
    }) as never);
  };

  // =====================================================================
  // Read (lightweight)
  // =====================================================================

  tool('list_collections', {
    title: 'List collections',
    description: 'List all collections (id, name, request count). Lightweight — no request contents.',
    inputSchema: {},
  }, async () => {
    const cols = await api.listCollections();
    return cols.map((c) => ({
      collection_id: c.id,
      name: c.name,
      base_url: c.baseUrl || null,
      request_count: (c.requests || []).length,
      updated_at: c.updatedAt,
    }));
  });

  tool('get_collection', {
    title: 'Get collection endpoints',
    description:
      'List the endpoints in one collection (request_id, name, method, url only — no body/headers/script). ' +
      'Use get_request for a single endpoint\'s full detail.',
    inputSchema: { collection_id: z.string() },
  }, async ({ collection_id }) => {
    const c = await api.getCollection(collection_id);
    if (!c) throw new Error(`Collection "${collection_id}" not found`);
    return {
      collection_id: c.id,
      name: c.name,
      base_url: c.baseUrl || null,
      folders: (c.folders || []).map((f) => ({
        folder_id: f.id,
        name: f.name,
        parent_folder_id: f.parentId || null,
        path: folderPath(c.folders, f.id),
      })),
      // A shell test sits in the same tree but has no method and no url; what
      // it runs is the command, so that is what stands in their place.
      endpoints: (c.requests || []).map((r) => (r.kind === 'shell'
        ? {
          request_id: r.id,
          request_name: r.name,
          kind: 'shell',
          command: r.command || '',
          folder_id: r.folderId || null,
        }
        : {
          request_id: r.id,
          request_name: r.name,
          method: r.method,
          url: r.url,
          folder_id: r.folderId || null,
        })),
    };
  });

  tool('get_request', {
    title: 'Get request detail',
    description:
      'Get the full content of one saved request (headers, params, body, script). ' +
      'Query this only when you actually need the detail, to keep token usage low.',
    inputSchema: { collection_id: z.string(), request_id: z.string() },
  }, async ({ collection_id, request_id }) => {
    const c = await api.getCollection(collection_id);
    if (!c) throw new Error(`Collection "${collection_id}" not found`);
    const r = (c.requests || []).find((x) => x.id === request_id);
    if (!r) throw new Error(`Request "${request_id}" not found in collection "${c.name}"`);
    if (r.kind === 'shell') {
      return {
        request_id: r.id,
        name: r.name,
        kind: 'shell',
        command: r.command || '',
        cwd: r.cwd || '',
        timeout_ms: r.timeout || null,
        vars: rowsToPlainObject(r.vars),
        script: r.script || '',
      };
    }
    const body = (r.bodies || []).find((b) => b.id === r.activeBodyId) || (r.bodies || [])[0];
    return {
      request_id: r.id,
      name: r.name,
      method: r.method,
      url: r.url,
      params: rowsToPlainObject(r.params),
      headers: rowsToPlainObject(r.headers),
      body_type: r.bodyType || 'none',
      body: body ? body.content : '',
      // Values kept on the request itself, which beat the environment when it
      // runs — without them it is impossible to tell from here why {{user_id}}
      // resolves for this request and nowhere else.
      vars: rowsToPlainObject(r.vars),
      // Only when the request does not simply inherit — otherwise a login here
      // looks identical to one that carries the collection's token.
      ...(authType(r) === 'inherit' ? {} : { auth: r.auth || { type: 'none' } }),
      script: r.script || '',
    };
  });

  tool('list_environments', {
    title: 'List environments',
    description: 'List all environments with their variables and disabled keys.',
    inputSchema: {},
  }, async () => {
    const envs = await api.listEnvironments();
    return envs.map((e) => ({
      environment_id: e.id,
      name: e.name,
      variables: e.variables || {},
      disabled: e.disabled || [],
    }));
  });

  tool('search_requests', {
    title: 'Search requests',
    description:
      'Search saved requests across all collections by name or URL (case-insensitive substring). ' +
      'Returns lightweight matches (ids, method, url).',
    inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
  }, async ({ query, limit }) => {
    const q = query.toLowerCase();
    const cols = await api.listCollections();
    const out: Array<Record<string, unknown>> = [];
    for (const c of cols) {
      for (const r of c.requests || []) {
        // A shell test has no url; what it runs is the command, so that is what
        // the query is matched against and what comes back.
        const what = r.kind === 'shell' ? (r.command || '') : (r.url || '');
        if (!(r.name || '').toLowerCase().includes(q) && !what.toLowerCase().includes(q)) continue;
        out.push({
          collection_id: c.id,
          collection_name: c.name,
          request_id: r.id,
          request_name: r.name,
          ...(r.kind === 'shell'
            ? { kind: 'shell', command: what }
            : { method: r.method, url: what }),
        });
      }
    }
    return out.slice(0, limit || 20);
  });

  // =====================================================================
  // Send
  // =====================================================================

  tool('send_request', {
    title: 'Send an HTTP request',
    description:
      'Send an ad-hoc HTTP request through the api-test backend (no browser CORS in the way). ' +
      '{{vars}} in url/headers/body are resolved from the given environment.',
    inputSchema: {
      method: z.string(),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      environment: z.string().optional(),
    },
  }, async ({ method, url, headers, body, environment }) => {
    await assertEnv(environment);
    // Handed to the backend unresolved, as a request that simply isn't filed
    // anywhere: it substitutes {{vars}} and sets Content-Type for a JSON body,
    // exactly as it does for a saved one. Resolving it here is how this tool
    // used to send something the app never would. With no collection there is
    // no folder path, so {{dy_url}} amounts to {{base_url}}.
    const record: HttpRequest = {
      id: newId(),
      name: 'Ad-hoc request',
      method,
      url,
      params: [],
      headers: toRows(headers),
      // Same test the Postman import uses to tell a JSON body from a text one.
      bodyType: body == null ? 'none' : (/^\s*[[{]/.test(body) ? 'json' : 'text'),
      bodies: [{ id: newId(), name: 'Default', content: body == null ? '' : body }],
      script: '',
    };
    record.activeBodyId = record.bodies![0]!.id;
    const out = await api.run({ request: record, environment });
    return shapeResponse(out.response);
  });

  tool('run_saved_request', {
    title: 'Run a saved request',
    description:
      'Run a stored request by id. Resolves {{vars}} from the environment and builds the url from its ' +
      'saved params. A {{dy_url}} token in the url expands to base_url + the request\'s folder path. ' +
      'Optional overrides replace url/headers/body before sending. ' +
      'A shell test (see save_shell_test) runs here too — it answers with exit_code, stdout and ' +
      'stderr instead of a response, and takes no overrides.',
    inputSchema: {
      collection_id: z.string(),
      request_id: z.string(),
      environment: z.string().optional(),
      overrides: z
        .object({
          url: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
        })
        .optional(),
    },
  }, async ({ collection_id, request_id, environment, overrides }) => {
    // The backend resolves and sends it — the same code path the app uses.
    // Rebuilding the call here is how this tool ended up not setting
    // Content-Type for JSON, not sending form-data and not running scripts.
    const out = await api.run({
      collection_id,
      request_id,
      environment,
      overrides,
    });
    return {
      ...shapeResponse(out.response),
      // Present when the request has a post-response script.
      ...(out.script ? { script: out.script } : {}),
    };
  });

  // =====================================================================
  // Write
  // =====================================================================

  tool('create_collection', {
    title: 'Create a collection',
    description:
      'Create a new empty collection. Optional base_url pins {{base_url}} for every request in it — ' +
      'set it when the collection targets its own service/container (e.g. http://localhost:8001).',
    inputSchema: { name: z.string(), base_url: z.string().optional() },
  }, async ({ name, base_url }) => {
    const c = await api.createCollection({ name, baseUrl: base_url || '' });
    return { collection_id: c.id, name: c.name, base_url: c.baseUrl || null, requests: [], updated_at: c.updatedAt };
  });

  tool('set_collection_base_url', {
    title: 'Set a collection base URL',
    description:
      'Set (or clear with "") the collection\'s own base_url. When set it overrides the environment\'s ' +
      '{{base_url}} for every request in the collection; it may contain {{vars}}. Use one collection per ' +
      'service/container, each with its own base_url.',
    inputSchema: { collection_id: z.string(), base_url: z.string() },
  }, async ({ collection_id, base_url }) => {
    const c = await api.getCollection(collection_id);
    if (!c) throw new Error(`Collection "${collection_id}" not found`);
    const saved = await api.patchCollection(c.id, { baseUrl: base_url });
    return { collection_id: saved.id, name: saved.name, base_url: saved.baseUrl || null };
  });

  tool('create_folder', {
    title: 'Create a folder',
    description:
      'Create a folder inside a collection (nest it with parent_folder_id). Folder names become URL ' +
      'path segments for {{dy_url}} — a request in folder prod/v1 with url {{dy_url}}/users resolves to ' +
      '{{base_url}}/prod/v1/users. Returns folder_id for use with save_request.',
    inputSchema: {
      collection_id: z.string(),
      name: z.string(),
      parent_folder_id: z.string().optional(),
    },
  }, async ({ collection_id, name, parent_folder_id }) => {
    const c = await api.getCollection(collection_id);
    if (!c) throw new Error(`Collection "${collection_id}" not found`);
    const folders = c.folders || [];
    if (parent_folder_id && !folders.some((f) => f.id === parent_folder_id)) {
      throw new Error(`Parent folder "${parent_folder_id}" not found in collection "${c.name}"`);
    }
    const folder: Folder = { id: newId(), name, parentId: parent_folder_id || null };
    const saved = await api.createFolder(c.id, folder);
    return {
      collection_id: saved.id,
      folder_id: folder.id,
      name: folder.name,
      parent_folder_id: folder.parentId,
      path: folderPath(saved.folders, folder.id),
    };
  });

  tool('save_request', {
    title: 'Save a request',
    description:
      'Add or update a request in a collection. Pass request.request_id to update an existing one; ' +
      'omit it to create a new one. On update every omitted field keeps its current value — including ' +
      'folder_id, and form-data fields and extra body variants, which this schema cannot express. ' +
      'Pass an empty object to clear headers/params/vars. Set request.folder_id to place it in a folder ' +
      '(see create_folder / get_collection). Prefer {{dy_url}}/... urls so the folder path applies.\n' +
      'vars: values for this request only, overriding the environment — put the {{user_id}} that one ' +
      'fetch-one call needs here rather than in an environment everything else carries.\n' +
      'script: JS run after the response, e.g. env.set("token", res.json().access_token) on a login ' +
      'request so later requests resolve {{token}}. Reads res.status / res.headers / res.cookies / ' +
      'res.body / res.json().\n' +
      'auth: what this request sends for authentication. {"type":"inherit"} (the default) uses the ' +
      'collection\'s. {"type":"none"} sends nothing — set it on every login, otherwise the login ' +
      'carries the token it is about to replace. {"type":"bearer","token":"{{token}}","prefix":"Bearer"} ' +
      'or {"type":"apikey","header":"X-API-Key","value":"{{token}}"} give this one request its own, ' +
      'in place of the collection\'s.',
    inputSchema: {
      collection_id: z.string(),
      request: z.object({
        request_id: z.string().optional(),
        name: z.string(),
        method: z.string(),
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
        params: z.record(z.string(), z.string()).optional(),
        body_type: z.enum(['none', 'json', 'text']).optional(),
        body: z.string().optional(),
        folder_id: z.string().optional(),
        vars: z.record(z.string(), z.string()).optional(),
        auth: z.object({
          type: z.enum(['inherit', 'none', 'bearer', 'apikey']),
          prefix: z.string().optional(),
          token: z.string().optional(),
          header: z.string().optional(),
          value: z.string().optional(),
        }).optional(),
        script: z.string().optional(),
      }),
    },
  }, async ({ collection_id, request }) => {
    const c = await api.getCollection(collection_id);
    if (!c) throw new Error(`Collection "${collection_id}" not found`);
    if (request.folder_id && !(c.folders || []).some((f) => f.id === request.folder_id)) {
      throw new Error(`Folder "${request.folder_id}" not found in collection "${c.name}"`);
    }

    // Saved requests are opened in the UI, so they keep the trailing empty row
    // an editable list expects.
    const rows = (obj?: Record<string, string>) => toRows(obj, { trailingBlank: true });

    // Reading the HTTP fields off whatever is stored under that id, without
    // first checking its kind — which is what this tool has always done.
    const prev = (request.request_id
      ? (c.requests || []).find((x) => x.id === request.request_id) || null
      : null) as HttpRequest | null;

    // An update carries over everything the caller didn't pass. This schema
    // models neither form-data fields (with their uploaded files) nor extra
    // body variants, so rebuilding the record from scratch would silently
    // destroy them — as omitting folder_id already avoids doing.

    // Body edits replace the active variant's content; the others survive.
    let bodies = prev && Array.isArray(prev.bodies) && prev.bodies.length
      ? prev.bodies
      : [{ id: newId(), name: 'Default', content: '' }];
    const activeBodyId = bodies.some((b) => prev && b.id === prev.activeBodyId)
      ? prev!.activeBodyId!
      : bodies[0]!.id;
    if (request.body !== undefined) {
      const content = request.body;
      bodies = bodies.map((b) => (b.id === activeBodyId ? { ...b, content } : b));
    }

    const record: HttpRequest = {
      ...prev, // form rows, uploaded file ids, script, anything newer than this tool
      id: request.request_id || newId(),
      name: request.name,
      method: request.method.toUpperCase(),
      url: request.url,
      params: request.params !== undefined ? rows(request.params) : (prev ? prev.params : rows()),
      headers: request.headers !== undefined ? rows(request.headers) : (prev ? prev.headers : rows()),
      bodyType: request.body_type || (prev ? prev.bodyType || 'none' : 'none'),
      bodies,
      activeBodyId,
      folderId: request.folder_id !== undefined
        ? (request.folder_id || null)
        : (prev ? prev.folderId || null : null),
      vars: request.vars !== undefined ? rows(request.vars) : (prev ? prev.vars || [] : []),
      // Omitted keeps what is there, whole — reducing it to its type alone
      // would drop the token beside it. Dropping noAuth as the request is
      // rewritten keeps one live answer per request rather than a stale
      // boolean sitting next to the type that replaced it.
      auth: request.auth !== undefined
        ? (request.auth as Auth)
        : (prev && prev.auth ? prev.auth : { type: authType(prev) } as Auth),
      noAuth: undefined,
      // The script the backend runs after the response. Omitting it keeps the
      // one already saved, the way every other field here behaves — pass '' to
      // remove it.
      script: request.script !== undefined ? request.script : (prev ? prev.script || '' : ''),
    };

    const saved = await api.putRequest(c.id, record);
    return { collection_id: saved.id, request_id: record.id, request: record };
  });

  tool('save_shell_test', {
    title: 'Save a shell test',
    description:
      'Add or update a test that runs a shell command instead of sending a request — for the part of '
      + 'a feature no response can show: that the row really is in the database, the file was written, '
      + 'the migration applied, the job ran. It is filed in a collection like any other test (folders '
      + 'and all), run on its own with run_saved_request, and a flow step can point at it with '
      + 'collection_id + request_id, exactly as it points at a request.\n'
      + 'Pass request_id to update an existing one; omitted fields keep their current value. '
      + '{{vars}} in command and cwd are resolved from the environment, then this test\'s own vars — '
      + 'so one saved check can be pointed at whatever the run is working on.\n'
      + 'The command runs on the machine hosting this backend, as that process. A non-zero exit is '
      + 'reported as-is; inside a flow it fails the step unless the step asserts on exit_code.\n'
      + 'Prefer an endpoint when one exists — a command ties the test to how the thing is deployed.',
    inputSchema: {
      collection_id: z.string(),
      test: z.object({
        request_id: z.string().optional(),
        name: z.string(),
        command: z.string().optional(),
        // Where to run it. Empty means the backend's own working directory.
        cwd: z.string().optional(),
        timeout_ms: z.number().int().positive().optional(),
        folder_id: z.string().optional(),
        vars: z.record(z.string(), z.string()).optional(),
        // Runs after the command: sh.exitCode / sh.stdout / sh.stderr, plus the
        // same res a request's script gets (res.status is the exit code,
        // res.body is stdout) and env.set to keep a value.
        script: z.string().optional(),
      }),
    },
  }, async ({ collection_id, test }) => {
    const c = await api.getCollection(collection_id);
    if (!c) throw new Error(`Collection "${collection_id}" not found`);
    if (test.folder_id && !(c.folders || []).some((f) => f.id === test.folder_id)) {
      throw new Error(`Folder "${test.folder_id}" not found in collection "${c.name}"`);
    }

    const prev = test.request_id
      ? (c.requests || []).find((x) => x.id === test.request_id) || null
      : null;
    if (prev && prev.kind !== 'shell') {
      throw new Error(
        `Request "${test.request_id}" in "${c.name}" is an HTTP request, not a shell test — `
        + 'save it with save_request, or leave request_id off to create a new shell test.',
      );
    }

    const keep = <T>(given: T | undefined, was: T | undefined, fallback: T | undefined) =>
      (given !== undefined ? given : (prev ? was : fallback));
    const record: ShellRequest = {
      ...prev,
      id: test.request_id || newId(),
      kind: 'shell',
      name: test.name,
      command: keep(test.command, prev ? prev.command : undefined, '')!,
      cwd: keep(test.cwd, prev ? prev.cwd : undefined, ''),
      timeout: keep(test.timeout_ms, prev ? prev.timeout : undefined, undefined),
      folderId: keep(test.folder_id, prev ? prev.folderId : undefined, null) || null,
      // Saved tests are opened in the UI, so they keep the trailing empty row
      // an editable list expects.
      vars: test.vars !== undefined
        ? toRows(test.vars, { trailingBlank: true })
        : (prev ? prev.vars || [] : []),
      script: keep(test.script, prev ? prev.script : undefined, ''),
    };

    const saved = await api.putRequest(c.id, record);
    return { collection_id: saved.id, request_id: record.id, test: record };
  });

  // =====================================================================
  // Flows
  // =====================================================================

  tool('list_flows', {
    title: 'List flows',
    description:
      'List saved flows (id, name, folder, step count), and the flow folder tree they are filed in.',
    inputSchema: {},
  }, async () => {
    const [list, folders] = await Promise.all([api.listFlows(), api.listFlowFolders()]);
    return {
      folders: folders.map((f) => ({
        folder_id: f.id,
        name: f.name,
        parent_folder_id: f.parentId || null,
        path: folderPath(folders, f.id),
      })),
      flows: list.map((f) => ({
        flow_id: f.id,
        name: f.name,
        description: f.description || '',
        folder_id: f.folderId || null,
        folder: f.folderId ? folderPath(folders, f.folderId) : null,
        steps: (f.steps || []).length,
        updated_at: f.updatedAt,
      })),
    };
  });

  tool('create_flow_folder', {
    title: 'Create a flow folder',
    description:
      'Create a folder to file flows under. Pass parent_folder_id to nest it. These folders are ' +
      'organisation only — unlike a collection\'s folders they carry no URL meaning, so name them ' +
      'after the feature the flows inside cover.',
    inputSchema: {
      name: z.string(),
      parent_folder_id: z.string().optional(),
    },
  }, async ({ name, parent_folder_id }) => {
    const { folder, folders } = await api.createFlowFolder({
      name, parentId: parent_folder_id || null,
    });
    return { folder_id: folder.id, name: folder.name, path: folderPath(folders, folder.id) };
  });

  tool('get_flow', {
    title: 'Get a flow',
    description: 'The full definition of one flow: its steps, extractions and assertions.',
    inputSchema: { flow_id: z.string() },
  }, async ({ flow_id }) => {
    const f = await api.getFlow(flow_id);
    if (!f) throw new Error(`Flow "${flow_id}" not found`);
    return f;
  });

  tool('save_flow', {
    title: 'Save a flow',
    description:
      'Create or replace a flow — an ordered list of saved requests run together to exercise one ' +
      'feature end to end (create -> read -> update -> delete). Pass flow_id to replace an existing ' +
      'one; the steps given always replace the stored list entirely. When editing an existing flow, ' +
      "carry each step's id over from get_flow — that keeps it the same step; a step sent without one " +
      'is treated as new and gets a fresh id. Set folder_id to file it in a ' +
      'flow folder (see list_flows / create_flow_folder); omit it to leave the flow at the root.\n' +
      'Always write a description: it is what tells whoever finds this flow later which case it ' +
      'covers and what it assumes, and it is the one thing a name has no room for. list_flows ' +
      'reports it, so it is also how you find the right flow again without opening each one.\n' +
      'Each step runs either a request typed into the step itself (mode:"inline" with '
      + 'inline:{method,url,...}) or a saved one (collection_id + request_id). Prefer inline: a step '
      + 'that exists to exercise a case is a test, and saving it would file a test case among the '
      + "collection's actual endpoints. An inline step may still name a collection_id, which lends it only that "
      + "collection's base_url and default auth — it has no folder, so {{dy_url}} is just {{base_url}}.\n"
      + 'inline.auth says what the step sends: {"type":"inherit"} (the default) takes the '
      + 'collection\'s, {"type":"none"} sends nothing — set that on a login step, or it carries the '
      + 'token it exists to replace — and bearer/apikey give the step its own.\n'
      + 'A step may instead run a shell command (mode:"shell" with command:"…"), for the part of a '
      + 'feature no response shows: that the row really landed, the file was written, the queue '
      + 'drained. {{vars}} are substituted into the command, so it can go looking for what an '
      + 'earlier step captured — e.g. command:"docker exec db psql -tAc \\"select count(*) from '
      + 'users where id={{user_id}}\\"". Assert on exit_code / stdout / stderr / time; stdout that '
      + 'is JSON takes a path like a body does. A non-zero exit fails the step by itself unless the '
      + 'step asserts on exit_code, which is how a check that means to prove a failure says so.\n'
      + 'Every command in a run shares one shell, so a cd, an export or a sourced env in one step is '
      + 'still there in the next — write a sequence as a sequence of steps rather than one command '
      + 'joined by &&, and each part gets its own assertions. shell_cwd is where that shell starts; a '
      + "step's own cwd cds there and stays there. Something that ends the shell (exit, a timeout, a "
      + 'command printing more than 1MB) leaves the next step to start a new one with none of that '
      + 'state, reported as fresh_shell. Pass shell_session:false for a flow whose commands must not '
      + 'be able to affect one another.\n'
      + 'Every step can:\n' +
      '- extract: capture a value into a run variable later steps use as {{var}} — e.g. ' +
      '{var:"user_id", from:"body", path:"data.id"} then url {{dy_url}}/{{user_id}}.\n' +
      '- assert: check the response. source status|body|header|cookie, op ' +
      'eq|neq|exists|missing|contains|matches|lt|gt. Values may contain {{vars}}.\n' +
      '- script: for checks the rules above cannot express, using expect(cond, message).\n' +
      '- always: run this step even after an earlier one failed — use it for the delete, or a failed ' +
      'run leaves its rows behind.\n' +
      'Run variables (including tokens a login script saves with env.set) live only for the run and ' +
      'never touch the stored environment.',
    inputSchema: {
      flow_id: z.string().optional(),
      name: z.string(),
      description: z.string().optional(),
      folder_id: z.string().optional(),
      environment: z.string().optional(),
      // What the flow's shell steps run in, for all of them at once.
      shell_session: z.boolean().optional(),
      shell_cwd: z.string().optional(),
      steps: z.array(z.object({
        // The id get_flow reported, so a step stays the same step across a save.
        // Left out, the store mints a fresh one, stranding whatever still points
        // at the old id — a single-step run, or a step opened in the UI.
        id: z.string().optional(),
        name: z.string().optional(),
        mode: z.enum(['saved', 'inline', 'shell']).optional(),
        collection_id: z.string().optional(),
        request_id: z.string().optional(),
        inline: z.object({
          method: z.string().optional(),
          url: z.string(),
          headers: z.record(z.string(), z.string()).optional(),
          params: z.record(z.string(), z.string()).optional(),
          body_type: z.enum(['none', 'json', 'text']).optional(),
          body: z.string().optional(),
          // Same four types a saved request has. A login typed into a flow
          // needs {"type":"none"} for exactly the reason one saved does.
          auth: z.object({
            type: z.enum(['inherit', 'none', 'bearer', 'apikey']),
            prefix: z.string().optional(),
            token: z.string().optional(),
            header: z.string().optional(),
            value: z.string().optional(),
          }).optional(),
        }).optional(),
        // Shell mode. {{vars}} in the command are resolved at run time, so a
        // command can go looking for what an earlier step captured. `cwd` is a
        // cd in the shell the flow shares, so the steps after this one carry on
        // from there unless they name a directory of their own.
        command: z.string().optional(),
        cwd: z.string().optional(),
        timeout_ms: z.number().optional(),
        enabled: z.boolean().optional(),
        always: z.boolean().optional(),
        extract: z.array(z.object({
          var: z.string(),
          from: z.enum([
            'body', 'header', 'cookie', 'status', 'time',
            'stdout', 'stderr', 'exit_code',
          ]).optional(),
          path: z.string().optional(),
        })).optional(),
        assert: z.array(z.object({
          source: z.enum([
            'status', 'body', 'header', 'cookie', 'time',
            'stdout', 'stderr', 'exit_code',
          ]),
          path: z.string().optional(),
          op: z.enum(['eq', 'neq', 'exists', 'missing', 'contains', 'matches', 'lt', 'gt']).optional(),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        })).optional(),
        script: z.string().optional(),
        overrides: z.object({
          url: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
        }).optional(),
      })),
    },
  }, async ({
    flow_id, name, description, folder_id, environment, shell_session, shell_cwd, steps,
  }) => {
    let environmentId: string | null = null;
    if (environment) {
      const env = await findEnv(environment);
      if (!env) throw new Error(`Environment "${environment}" not found`);
      environmentId = env.id;
    }
    const record = {
      name,
      description: description || '',
      folderId: folder_id || null,
      environmentId,
      shell: { session: shell_session !== false, cwd: shell_cwd || '' },
      steps: (steps || []).map((s, i) => {
        // The step says which it is, but a step carrying only an inline request
        // clearly means inline — making callers state it twice is a trap.
        const mode = s.mode
          || (s.command ? 'shell' : (s.inline && !s.request_id ? 'inline' : 'saved'));
        const where = `Step ${i + 1}${s.name ? ` ("${s.name}")` : ''}`;
        if (mode === 'inline' && !s.inline) {
          throw new Error(`${where} is inline but has no inline request — give it inline:{url:…}`);
        }
        if (mode === 'shell' && !(s.command || '').trim()) {
          throw new Error(`${where} is a shell step but has no command — give it command:"…"`);
        }
        if (mode === 'saved' && !(s.collection_id && s.request_id)) {
          throw new Error(
            `${where} needs collection_id and request_id, mode:"inline" with an inline request, `
            + 'or mode:"shell" with a command',
          );
        }
        return {
          id: s.id || undefined,
          name: s.name || '',
          mode,
          collectionId: s.collection_id || null,
          requestId: s.request_id || null,
          request: s.inline && inlineFromMcp(s.inline as McpInline),
          command: s.command || '',
          cwd: s.cwd || '',
          timeout: s.timeout_ms,
          enabled: s.enabled !== false,
          always: s.always === true,
          extract: s.extract || [],
          assert: s.assert || [],
          script: s.script || '',
          overrides: s.overrides,
        };
      }),
    };
    const saved = flow_id
      ? await api.updateFlow(flow_id, { ...record, id: flow_id })
      : await api.createFlow(record);
    return {
      flow_id: saved.id, name: saved.name, folder_id: saved.folderId || null,
      steps: saved.steps.length,
    };
  });

  tool('run_flow', {
    title: 'Run a flow',
    description:
      'Run every step in order and report what passed. Stops at the first failure — a chain cannot ' +
      'continue without the id the failed step was to produce — but steps marked always still run, ' +
      'so cleanup happens. Passing steps are reported as one line each; failures carry the assertion ' +
      'that broke and the response body.',
    inputSchema: { flow_id: z.string(), environment: z.string().optional() },
  }, async ({ flow_id, environment }) => {
    const report = await api.runFlow(flow_id, { environment });
    if (!report.steps.length) {
      return { flow: report.name, ok: true, note: 'This flow has no steps yet — nothing ran.' };
    }
    // Compact on purpose: a full report of every passing step's response would
    // crowd out the reason the run actually failed.
    return {
      flow: report.name,
      ok: report.ok,
      duration_ms: report.durationMs,
      steps: report.steps.map((s) => {
        if (s.skipped) return `- ${s.name}: skipped (${s.skipped})`;
        // A shell step has no status to report; its exit code is the verdict.
        const verdict = s.mode === 'shell' ? `exit ${s.exitCode}` : s.status;
        if (s.ok) return `PASS ${s.name}: ${verdict} (${s.timeMs}ms)`;
        return {
          step: s.name,
          status: verdict,
          failed: (s.assertions || []).filter((a) => !a.ok).map((a) => a.detail),
          // What the step sent, with this run's variables resolved into it — a
          // step usually fails because the call was not the one intended, and
          // the saved request cannot show that: an id captured two steps back
          // only exists in the url and body that actually went out.
          ...(s.mode === 'shell'
            ? { sent: s.command }
            : s.request
              ? {
                sent: `${s.request.method} ${s.request.url}`,
                ...(s.request.body ? { sent_body: s.request.body.slice(0, 2000) } : {}),
              }
              : {}),
          ...(s.error ? { error: s.error } : {}),
          ...(s.script ? { script_error: s.script.error } : {}),
          // Where a failing command explains itself — and, when the shell the
          // run was sharing had died, that this one started from nothing.
          ...(s.shell && s.shell.stderr ? { stderr: s.shell.stderr.slice(0, 2000) } : {}),
          ...(s.freshShell ? { fresh_shell: true } : {}),
          // The report now carries the whole body for every step; a failure
          // report here wants the head of it, not twenty thousand characters.
          ...(s.response && s.response.body ? { body: s.response.body.slice(0, 2000) } : {}),
        };
      }),
      vars: report.vars,
    };
  });

  tool('set_env_var', {
    title: 'Set an environment variable',
    description:
      'Create or update a variable in an environment — e.g. store a token from a login response so ' +
      'later requests can use {{token}}.',
    inputSchema: { environment: z.string(), key: z.string(), value: z.string() },
  }, async ({ environment, key, value }) => {
    const env = await findEnv(environment);
    if (!env) {
      const envs = await api.listEnvironments();
      const names = envs.map((e) => e.name).join(', ') || '(none)';
      throw new Error(`Environment "${environment}" not found. Available: ${names}`);
    }
    const variables = { ...(env.variables || {}), [key]: value };
    const saved = await api.updateEnvironment(env.id, { ...env, variables });
    return { environment_id: saved.id, name: saved.name, variables: saved.variables };
  });

  return server;
}

// =====================================================================
// Transports
// =====================================================================

// A browser sends Origin on every cross-origin fetch; a real MCP client sends
// none at all. That asymmetry is the whole defence here: a page on evil.com
// cannot drive these tools even after pointing its own DNS at 127.0.0.1,
// because the Origin it must send still says evil.com. Worth having because
// reaching this port means reaching every tool, and the tools reach a backend
// that executes post-response scripts.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// MCP messages are small — a saved request carrying a body is the largest thing
// that passes through. Without a ceiling one POST can grow the process until it
// dies.
const MAX_BODY = 4 * 1024 * 1024;

// Long-lived Streamable HTTP service. Sessions are tracked by the
// mcp-session-id header; each new session gets its own server instance.
function startHttp(port: number): void {
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // A session id this process does not know is almost always one an earlier
  // run of it issued: sessions live in memory here, so restarting — which
  // `npm run dev` does on every edit under mcp/ — takes all of them with it.
  // 404 is what says that, and the protocol makes it the client's cue to open a
  // new session with a fresh initialize. A 400 reads as "you sent nonsense"
  // instead, which is why a restart used to leave the client disconnected until
  // somebody reconnected it by hand.
  function noSuchSession(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Session not found — this server has restarted. Initialize a new session.',
      },
      id: null,
    }));
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    if (sid && transports[sid]) {
      transport = transports[sid]!;
    } else if (isInitializeRequest(body)) {
      // Whatever session id came with it: a client asking to initialize is
      // asking for a new session, and refusing it over a stale header would
      // leave it with no way back in.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport; },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await createServer().connect(transport);
    } else if (sid) {
      noSuchSession(res);
      return;
    } else {
      // No session and not an initialize: the client skipped the handshake,
      // which is a different mistake and not one a reconnect fixes.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: initialize first, or send a session ID' },
        id: null,
      }));
      return;
    }
    await transport.handleRequest(req, res, body);
  }

  async function handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid && transports[sid]) {
      await transports[sid]!.handleRequest(req, res);
      return;
    }
    // Same distinction as above: a stale id is a restart to recover from, a
    // missing one is a client that never opened a session at all.
    if (sid) {
      noSuchSession(res);
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: missing session ID' },
      id: null,
    }));
  }

  const httpServer = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && !LOOPBACK_ORIGIN.test(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden origin');
      return;
    }
    const path = (req.url || '').split('?')[0];
    if (path !== '/mcp') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (req.method === 'POST') {
      let raw = '';
      let tooBig = false;
      // Decode as a stream: a chunk boundary can fall inside a multi-byte
      // character, which per-chunk toString() would turn into U+FFFD.
      req.setEncoding('utf8');
      req.on('data', (c: string) => {
        if (tooBig) return;
        raw += c;
        if (raw.length > MAX_BODY) {
          tooBig = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end('{"jsonrpc":"2.0","error":{"code":-32600,"message":"Request too large"},"id":null}');
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooBig) return;
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}');
          return;
        }
        handlePost(req, res, body).catch((err) => {
          console.error(err);
          if (!res.headersSent) { res.writeHead(500); res.end(); }
        });
      });
      // The reset we caused by hanging up on an oversized body is not news.
      req.on('error', (err) => { if (!tooBig) console.error(err); });
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      handleSession(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
    } else {
      res.writeHead(405);
      res.end('Method Not Allowed');
    }
  });

  // Loopback by default — these tools drive the backend, which runs scripts, so
  // reaching this port is as good as a shell here. MCP_HTTP_HOST overrides the
  // bind address; there is no good reason to widen it.
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
  httpServer.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    console.error(`api-test MCP (HTTP) ready on http://${shown}:${port}/mcp (backend: ${api.base})`);
  });
}

const httpPort = process.env.MCP_HTTP_PORT;
if (httpPort) {
  startHttp(Number(httpPort));
} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`api-test MCP server ready over stdio (backend: ${api.base})`);
}
