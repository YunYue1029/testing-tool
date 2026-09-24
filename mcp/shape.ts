// What the tools read and write, between the backend's records and a tool
// call's flat shape: rows as objects, vars by environment name, a flow as
// save_flow takes it, a response cut to what a result has room for — and the
// lookups that throw naming what was asked for.
import { z } from 'zod';
import { api } from './api.ts';
import { newId } from '../server/ids.ts';
import type {
  Auth, Collection, Environment, Flow, Folder, HttpRequest, HttpResponse, InlineRequest,
  RequestBody, Row, SavedRequest, ShellResponse,
} from '../server/types.ts';

// ---- display helpers ----
// Nothing here decides what gets sent. Every tool that sends something posts to
// the backend's /api/run, so server/resolve.ts is the only place {{vars}},
// {{dy_url}} and auth are worked out. This code used to carry a copy of those
// rules, which is exactly how it ended up sending something different from the
// app; the tools import folderPath and requestAuthType from there for the same
// reason, being the two they still need in order to describe a request.

// Stored rows as {key: value}, {{vars}} left as they are — this reports what is
// saved, not what would be sent.
export function rowsToPlainObject(rows: Row[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows || []) {
    if (r.enabled === false || !r.key) continue;
    out[r.key] = r.value;
  }
  return out;
}

// The row shape the app stores. `trailingBlank` adds the empty row the UI keeps
// at the bottom of an editable list — wanted for a request being saved,
// pointless for a one-off send.
export function toRows(
  obj: Record<string, string> | undefined,
  { trailingBlank = false }: { trailingBlank?: boolean } = {},
): Row[] {
  const rows = Object.entries(obj || {}).map(([key, value]) => ({ key, value, enabled: true }));
  if (trailingBlank) rows.push({ key: '', value: '', enabled: true });
  return rows;
}

// A request's auth as a tool call writes it: flat, every field optional, since
// a schema cannot say "token when bearer, header and value when apikey". The
// backend normalises it; here it is only carried.
export const authIn = z.object({
  type: z.enum(['inherit', 'none', 'bearer', 'apikey']),
  prefix: z.string().optional(),
  token: z.string().optional(),
  header: z.string().optional(),
  value: z.string().optional(),
});

// A flow step's own request, in the flat shape a tool call gives. Headers and
// params arrive as objects here — a caller writing {"Authorization": "Bearer
// {{token}}"} shouldn't have to spell out rows.
export const inlineIn = z.object({
  method: z.string().optional(),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
  body_type: z.enum(['none', 'json', 'text']).optional(),
  body: z.string().optional(),
  auth: authIn.optional(),
});
export type McpInline = z.infer<typeof inlineIn>;

// The body type a body implies when the caller named none: the same test the
// Postman import uses to tell a JSON body from a text one. No body means none —
// a request stored as 'none' never sends what it carries.
export function guessBodyType(body: string | undefined): 'none' | 'json' | 'text' {
  if (!body) return 'none';
  return /^\s*[[{]/.test(body) ? 'json' : 'text';
}

export function inlineFromMcp(inline: McpInline): InlineRequest {
  return {
    method: (inline.method || 'GET').toUpperCase(),
    url: inline.url,
    headers: toRows(inline.headers),
    params: toRows(inline.params),
    bodyType: inline.body_type || guessBodyType(inline.body),
    body: inline.body || '',
    auth: (inline.auth as Auth | undefined) || { type: 'inherit' },
  };
}

// The other way, for get_flow: a stored inline request as save_flow takes it,
// so the caller edits what it read and passes it back untranslated.
function inlineToMcp(r: InlineRequest): McpInline {
  return {
    method: r.method,
    url: r.url,
    headers: rowsToPlainObject(r.headers),
    params: rowsToPlainObject(r.params),
    body_type: r.bodyType || 'none',
    body: r.body || '',
    ...(r.auth && r.auth.type !== 'inherit' ? { auth: r.auth } : {}),
  };
}


// How much of a response body a tool result carries unless the caller asks
// for more (max_body_chars). Enough to read an error or a record, not the
// whole listing a happy path returns.
const DEFAULT_MAX_BODY_CHARS = 4000;

// A body cut to what the result has room for, marked when cut so a missing
// tail is not mistaken for the whole. `key` names the field, and the marks sit
// beside it: body / body_truncated / body_length.
export function clipped(key: string, text: string, max = DEFAULT_MAX_BODY_CHARS): Record<string, unknown> {
  if (text.length <= max) return { [key]: text };
  return { [key]: text.slice(0, max), [`${key}_truncated`]: true, [`${key}_length`]: text.length };
}

// ---- environment helpers ----
// A var as a tool call writes it: one value, which is the default
// environment's, or {default, <environment name>: value} where environments
// really differ.
export const varValue = z.union([z.string(), z.record(z.string(), z.string())]);
export type VarValue = z.infer<typeof varValue>;

// Stored rows from what a tool call gave. Environments are named the way a
// caller knows them and stored by id, so a rename does not strand the value.
export async function varsToRows(
  obj: Record<string, VarValue> | undefined,
  { trailingBlank = false } = {},
): Promise<Row[]> {
  // The listing is only needed to turn a name into an id, so a call whose
  // values are all plain strings does not pay for it.
  const perEnv = Object.values(obj || {}).some((v) => typeof v !== 'string');
  const envs = perEnv ? await api.listEnvironments() : [];
  const out: Row[] = Object.entries(obj || {}).map(([key, v]) => {
    if (typeof v === 'string') return { key, value: v, enabled: true };
    const byEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(v)) {
      if (name === 'default' || value === '') continue;
      const env = envs.find((e) => e.id === name || e.name === name);
      if (!env) {
        throw new Error(`vars.${key}: no environment "${name}" — have: `
          + `${envs.map((e) => e.name).join(', ') || 'none'} (or "default")`);
      }
      byEnv[env.id] = value;
    }
    return {
      key, value: v.default || '', enabled: true,
      ...(Object.keys(byEnv).length ? { byEnv } : {}),
    };
  });
  if (trailingBlank) out.push({ key: '', value: '', enabled: true });
  return out;
}

// The other way: a plain value where a var has one, {default, <name>: value}
// where it also varies by environment — the shape varsToRows takes back.
export async function varsOut(
  rows: Row[] | undefined,
  envs?: Environment[],
): Promise<Record<string, VarValue>> {
  const withEnv = (rows || []).some((r) => r.byEnv && Object.keys(r.byEnv).length);
  if (!withEnv) return rowsToPlainObject(rows);
  const names = new Map((envs || await api.listEnvironments()).map((e) => [e.id, e.name]));
  const out: Record<string, VarValue> = {};
  for (const r of rows || []) {
    if (r.enabled === false || !r.key) continue;
    const own = Object.entries(r.byEnv || {}).filter(([id]) => names.has(id));
    out[r.key] = own.length
      ? { default: r.value, ...Object.fromEntries(own.map(([id, v]) => [names.get(id)!, v])) }
      : r.value;
  }
  return out;
}

// An environment by name or id, from one listing. The backend resolves the
// same reference itself, but its "not found" carries no list of what does
// exist, which is the only thing that helps from here.
export async function requireEnv(ref: string): Promise<Environment> {
  const envs = await api.listEnvironments();
  const env = envs.find((e) => e.id === ref || e.name === ref);
  if (env) return env;
  const names = envs.map((e) => e.name).join(', ') || '(none)';
  throw new Error(`Environment "${ref}" not found. Available: ${names}`);
}

// A flow as save_flow takes it, so get -> edit -> save needs no translation:
// snake_case, headers and params as objects, the environment by name, and
// every step carrying the id that keeps it the same step across the save.
// Fields at their default (enabled, always, empty lists) are left out — they
// come back the same through save_flow, and every step would repeat them.
export async function flowOut(f: Flow, envs?: Environment[]) {
  const env = f.environmentId && envs ? envs.find((e) => e.id === f.environmentId) : undefined;
  return {
    flow_id: f.id,
    name: f.name,
    description: f.description || '',
    folder_id: f.folderId || null,
    environment: env ? env.name : null,
    vars: await varsOut(f.vars, envs),
    shell_session: !f.shell || f.shell.session !== false,
    shell_cwd: (f.shell && f.shell.cwd) || '',
    steps: (f.steps || []).map((s) => ({
      id: s.id,
      name: s.name || '',
      mode: s.mode,
      ...(s.collectionId ? { collection_id: s.collectionId } : {}),
      ...(s.requestId ? { request_id: s.requestId } : {}),
      ...(s.request ? { inline: inlineToMcp(s.request) } : {}),
      ...(s.command ? { command: s.command } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.timeout ? { timeout_ms: s.timeout } : {}),
      ...(s.enabled === false ? { enabled: false } : {}),
      ...(s.always ? { always: true } : {}),
      ...(s.when && s.when.length ? { when: s.when } : {}),
      ...(s.extract && s.extract.length ? { extract: s.extract } : {}),
      ...(s.assert && s.assert.length ? { assert: s.assert } : {}),
      ...(s.script ? { script: s.script } : {}),
      ...(s.overrides ? { overrides: s.overrides } : {}),
    })),
    updated_at: f.updatedAt,
  };
}

// ---- body variants ----
// A request keeps several named bodies and sends one of them: the payloads a
// route is tested with ("valid", "missing field") sitting side by side instead
// of being edited over each other.

// ---- lookups ----
// Each answers with the thing or throws naming what was asked for. The backend
// would answer some of these with success (a request id that was never there
// deletes nothing) and others with a bare "Not found", so the check is here.
export async function requireCollection(id: string): Promise<Collection> {
  const c = await api.getCollection(id);
  if (!c) throw new Error(`Collection "${id}" not found`);
  return c;
}

export function requireFolder(c: Collection, folderId: string): Folder {
  const f = (c.folders || []).find((x) => x.id === folderId);
  if (!f) throw new Error(`Folder "${folderId}" not found in collection "${c.name}"`);
  return f;
}

export function requireRequest(c: Collection, requestId: string): SavedRequest {
  const r = (c.requests || []).find((x) => x.id === requestId);
  if (!r) throw new Error(`Request "${requestId}" not found in collection "${c.name}"`);
  return r;
}

// Only a request that can have a body at all — a shell test has none.
export async function httpRequestIn(collectionId: string, requestId: string) {
  const collection = await requireCollection(collectionId);
  const r = requireRequest(collection, requestId);
  if (r.kind === 'shell') {
    throw new Error(`"${r.name}" is a shell test — it runs a command and has no body.`);
  }
  return { collection, request: r };
}

// The stored variants, with the one that actually gets sent settled. A request
// saved before variants existed, or with a dangling activeBodyId, still has to
// answer both questions.
export function bodyVariants(r: HttpRequest): { bodies: RequestBody[]; activeId: string } {
  const bodies = Array.isArray(r.bodies) && r.bodies.length
    ? r.bodies
    : [{ id: newId(), name: 'Default', content: '' }];
  const activeId = bodies.some((b) => b.id === r.activeBodyId) ? r.activeBodyId! : bodies[0]!.id;
  return { bodies, activeId };
}

// Variants are addressed by name — which is the whole point of naming them.
// A repeated name resolves to the first, and the listing shows the clash.
export function findVariant(bodies: RequestBody[], name: string): RequestBody | undefined {
  return bodies.find((b) => b.name === name);
}

export function requireVariant(r: HttpRequest, bodies: RequestBody[], name: string): RequestBody {
  const b = findVariant(bodies, name);
  if (!b) {
    throw new Error(`Body "${name}" not found on "${r.name}". Stored: ${bodies.map((x) => x.name).join(', ')}`);
  }
  return b;
}

// What every body-variant tool answers with: the list as it now stands, so the
// caller never has to re-read the request to see what it did. Content is left
// out — it is what was just sent in, and the others can be large.
export function variantReport(collection: Collection, requestId: string, extra: Record<string, unknown>) {
  const r = (collection.requests || []).find((x) => x.id === requestId) as HttpRequest | undefined;
  const { bodies, activeId } = r
    ? bodyVariants(r)
    : { bodies: [] as RequestBody[], activeId: '' };
  const active = bodies.find((b) => b.id === activeId);
  return {
    collection_id: collection.id,
    request_id: requestId,
    ...extra,
    // A body is only sent when the type says there is one, however many
    // variants are stored — worth saying, or an added variant looks live.
    body_type: r ? r.bodyType || 'none' : 'none',
    active_body: active ? active.name : null,
    bodies: bodies.map((b) => ({
      name: b.name,
      active: b.id === activeId,
      chars: (b.content || '').length,
    })),
  };
}

function isShellResponse(r: HttpResponse | ShellResponse): r is ShellResponse {
  return 'kind' in r && r.kind === 'shell';
}

// Shape a backend response for tool output. `maxBodyChars` is the caller's
// own cap on the body (and a command's streams), over the default.
export function shapeResponse(r: HttpResponse | ShellResponse, maxBodyChars?: number) {
  // A shell test ran a command instead of sending anything: its verdict is the
  // exit code, and what it has to say is on the two streams. Reporting it in a
  // response's shape would mean calling an exit code a status.
  if (isShellResponse(r)) {
    return {
      exit_code: r.exitCode,
      time_ms: r.time,
      ...clipped('stdout', r.stdout || '', maxBodyChars),
      ...clipped('stderr', r.stderr || '', maxBodyChars),
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
    ...clipped('body', r.body || '', maxBodyChars),
  };
}
