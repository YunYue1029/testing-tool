// The client's half of the request rules: the pieces only the editor needs —
// empty rows, bringing a stored request up to shape, describing auth for the UI.
// The rules that decide what actually gets sent live in server/resolve.ts and
// are re-exported below, so what you see previewed and what the server builds
// cannot drift apart.
import type {
  Auth, AuthDescription, AuthForm, Collection, CollectionAuth, Flow, FormRow,
  HttpRequest, InlineRequest, Overrides, RequestBody, Row, SavedRequest,
  ShellRequest, Vars,
} from './types.ts';
import { authHeader, folderPath, requestAuthType, substitute } from '../../server/resolve.ts';
import { newId } from '../../server/ids.ts';

export { newId } from '../../server/ids.ts';

// Re-exported so the rest of the client goes on importing them from './util'.
export {
  VAR_RE, DEFAULT_BASE_URL, substitute, rowsToObject, requestVars, collapseSlashes,
  folderChain, folderPath, folderWithDescendants, dyUrl, composeUrl, buildUrl,
  authHeader, requestAuthType, applyCollectionBaseUrl, baseUrlVar,
} from '../../server/resolve.ts';

// ---- Showing a response (shared by the response panel and a flow's steps) ----

// Indent a JSON body. Content-type decides, with a look at the first character
// for the servers that answer JSON as text/plain.
export function prettify(body: string, headers?: Record<string, string>): string {
  const ct = (headers && (headers['content-type'] || headers['Content-Type'])) || '';
  if (ct.includes('json') || (body && /^[\s\r\n]*[[{]/.test(body))) {
    try { return JSON.stringify(JSON.parse(body), null, 2); } catch { /* not JSON after all */ }
  }
  return body;
}

export function fmtSize(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Grows a textarea to fit what is in it, for the fields whose length is the
// author's to decide — a command, a description. Use it as a ref and again on
// change; CSS max-height decides when it has taken enough room.
export function fitToContent(el: HTMLElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

// Names of the {{var}} tokens substitution left behind — i.e. the variables
// the active environment doesn't define. Builds its own regex per call: VAR_RE
// carries /g state, so reusing it across calls skips matches.
export function unresolvedVarNames(str: string | null | undefined): string[] {
  return [...String(str || '').matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]!);
}

// Every {{token}} this request mentions, deduped. dy_url and base_url are left
// out: they come from the folder path and the collection, so offering to give
// them a per-request value would only invite trouble.
export function usedVarNames(request: SavedRequest): string[] {
  const names = new Set<string>();
  const scan = (s: string | null | undefined) => {
    for (const n of unresolvedVarNames(s)) names.add(n);
  };
  // A shell test's two fields are its command and where it runs — the same
  // question, asked of the thing it actually has.
  if (isShellTest(request)) {
    scan(request.command);
    scan(request.cwd);
    return [...names];
  }
  scan(request.url);
  const rows: Array<Row | FormRow> = [
    ...(request.params || []), ...(request.headers || []), ...(request.form || []),
  ];
  for (const r of rows) {
    if (r.enabled === false) continue;
    scan(r.key);
    if (!('type' in r) || r.type !== 'file') scan(r.value);
  }
  for (const b of request.bodies || []) scan(b.content);
  names.delete('dy_url');
  names.delete('base_url');
  return [...names];
}

// Every {{token}} a flow's steps mention that no step captures — what the
// flow needs from outside the run, so its own vars editor can offer them. A
// saved request's tokens count too: the step sends them.
export function flowUsedVarNames(flow: Flow, collections: Collection[]): string[] {
  const names = new Set<string>();
  const scan = (s: string | null | undefined) => {
    for (const n of unresolvedVarNames(s)) names.add(n);
  };
  const captured = new Set<string>();
  for (const step of flow.steps || []) {
    if (step.enabled === false) continue;
    for (const e of step.extract || []) captured.add(e.var);
    if (step.mode === 'shell') {
      scan(step.command);
      scan(step.cwd);
    } else if (step.mode === 'inline' && step.request) {
      const r = step.request;
      scan(r.url);
      scan(r.body);
      for (const row of [...(r.headers || []), ...(r.params || [])]) {
        if (row.enabled === false) continue;
        scan(row.key);
        scan(row.value);
      }
    } else {
      const col = collections.find((c) => c.id === step.collectionId);
      const saved = col && col.requests.find((q) => q.id === step.requestId);
      if (saved) for (const n of usedVarNames(saved)) names.add(n);
    }
    const o = step.overrides;
    if (o) {
      scan(o.url);
      scan(o.body);
      for (const v of Object.values(o.headers || {})) scan(v);
    }
    for (const a of step.assert || []) if (typeof a.value === 'string') scan(a.value);
    for (const c of step.when || []) {
      if (c.var && !captured.has(c.var)) names.add(c.var);
      scan(c.value);
    }
  }
  for (const n of captured) names.delete(n);
  names.delete('dy_url');
  names.delete('base_url');
  return [...names];
}

export function emptyRow(): Row {
  return { key: '', value: '', enabled: true };
}

export function emptyBody(name = 'Default'): RequestBody {
  return { id: newId(), name, content: '' };
}

// One multipart/form-data field. `type` is 'text' or 'file'; a file row carries
// the id of an upload held by the server plus its name/size for display.
export function emptyFormRow(): FormRow {
  return { key: '', type: 'text', value: '', enabled: true };
}

export function newRequest(): HttpRequest {
  const body = emptyBody();
  return {
    id: newId(),
    name: 'New Request',
    method: 'GET',
    url: '',
    params: [emptyRow()],
    headers: [emptyRow()],
    bodyType: 'none', // none | json | text | form
    bodies: [body], // named body variants; the active one is sent
    activeBodyId: body.id,
    form: [emptyFormRow()], // multipart fields, used when bodyType === 'form'
    vars: [], // values for this request's {{vars}}; override the environment
    auth: { type: 'inherit' }, // inherit | none | bearer | apikey — see authFormState
    script: '', // post-response script; can save values via env.set()
  };
}

// A test that runs a command instead of sending a request, for the part of a
// feature no response shows: that the row really landed, the file was written,
// the queue drained. It is filed in a collection like any other test — same
// tree, same folders — because it proves something about the same feature, and
// a flow can point a step at it exactly as it points one at a request.
export function newShellTest(): ShellRequest {
  return {
    id: newId(),
    name: 'New Shell Test',
    kind: 'shell',
    command: '',
    cwd: '', // where to run it; empty means the server's own directory
    timeout: undefined, // ms; the server's default (30s) when unset
    vars: [],
    script: '', // runs after the command; res.status is the exit code, res.body is stdout
  };
}

export function isShellTest(r: SavedRequest | null | undefined): r is ShellRequest {
  return !!r && r.kind === 'shell';
}

// Bring a stored request up to the current shape. Requests saved before body
// variants existed have a single `body` string — turn it into the first variant.
export function normalizeRequest(r: SavedRequest): SavedRequest {
  // A shell test has none of what follows — no params, headers, bodies or
  // auth — and filling those in would only leave fields nothing ever reads.
  if (isShellTest(r)) {
    return { ...newShellTest(), ...r, vars: Array.isArray(r.vars) ? r.vars : [] };
  }
  // A request saved before body variants existed keeps its single `body`
  // string, which no current type admits to — hence the wider shape here.
  const base = {
    params: [emptyRow()], headers: [emptyRow()], bodyType: 'none', script: '',
    form: [emptyFormRow()], vars: [], ...r,
  } as HttpRequest & { body?: string; noAuth?: boolean };
  if (!Array.isArray(base.form) || !base.form.length) base.form = [emptyFormRow()];
  if (!Array.isArray(base.vars)) base.vars = [];
  // `noAuth` was the whole of a request's say over auth before it could carry
  // its own. Fold it into the type it always meant, and drop it, so nothing
  // downstream has to keep asking which of the two is the live one.
  if (!base.auth || !base.auth.type) base.auth = { type: base.noAuth ? 'none' : 'inherit' };
  delete base.noAuth;
  let bodies = Array.isArray(base.bodies) ? base.bodies : [];
  if (!bodies.length) bodies = [{ ...emptyBody(), content: base.body || '' }];
  const activeBodyId = bodies.some((b) => b.id === base.activeBodyId)
    ? base.activeBodyId
    : bodies[0]!.id;
  delete base.body;
  return { ...base, bodies, activeBodyId };
}

export function activeBody(request: HttpRequest): RequestBody | undefined {
  return (request.bodies || []).find((b) => b.id === request.activeBodyId)
    || (request.bodies || [])[0];
}

// The body a flow step takes a copy of when it points at a saved request. A
// flow borrows the request's frame — its url, headers and auth, and any later
// fix to them — but the payload is the case the flow is making, so the step
// carries its own: editing a request under Tests to try something must not
// quietly rewrite what every flow using it sends. A form body has no single
// string to copy (the override would replace the multipart fields with a plain
// body) and 'none' has nothing to copy, so both keep following the request.
export function copyableBody(request: SavedRequest | null | undefined): string | undefined {
  if (!request || request.kind === 'shell') return undefined;
  const type = request.bodyType || 'none';
  if (type === 'none' || type === 'form') return undefined;
  return activeBody(request)?.content || '';
}

// Overrides with the copied body set, or with it dropped when there is nothing
// to copy. An overrides object with nothing left in it is stored as none at
// all, so a step that overrides nothing reads as one.
export function withBodyOverride(
  overrides: Overrides | undefined, body: string | undefined,
): Overrides | undefined {
  const next: Overrides = { ...overrides };
  if (body == null) delete next.body;
  else next.body = body;
  return Object.keys(next).length ? next : undefined;
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// A flow step's own request, for an endpoint that isn't worth saving anywhere.
// Shared by the panel that builds a step and the dialog that edits one.
export function emptyInlineRequest(): InlineRequest {
  return {
    method: 'GET', url: '', headers: [], params: [], bodyType: 'none', body: '',
    // Same four types a saved request offers; 'inherit' takes the collection's,
    // when the step names one.
    auth: { type: 'inherit' },
  };
}

// A collection's requests grouped by their folder path, ready to render as
// <optgroup>s. Picking one out of a collection of fifty means finding its
// folder rather than reading the whole list, and the folder tree is the
// collection's route structure — which is how you already think about where an
// endpoint lives.
export function requestGroups(
  collections: Collection[] | undefined, collectionId: string | null | undefined,
): Array<[string, SavedRequest[]]> {
  const c = (collections || []).find((x) => x.id === collectionId);
  if (!c) return [];
  const byPath = new Map<string, SavedRequest[]>();
  for (const r of c.requests || []) {
    const p = folderPath(c.folders || [], r.folderId);
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p)!.push(r);
  }
  return [...byPath.entries()]
    // Root-level requests first, then folders alphabetically.
    .sort(([a], [b]) => (a ? (b ? a.localeCompare(b) : 1) : -1))
    .map(([p, list]): [string, SavedRequest[]] => [
      p,
      list.sort((x, y) => (x.name || urlOf(x) || '').localeCompare(y.name || urlOf(y) || '')),
    ]);
}

// What a request shows of where it points — a url, or for a shell test the
// command, which is the only thing it has to be sorted or searched by.
function urlOf(r: SavedRequest): string {
  return isShellTest(r) ? (r.command || '') : (r.url || '');
}

// The editable state behind an auth picker. Every type's fields are kept while
// you switch between them, so flipping to No Auth and back doesn't lose the
// token you just typed. `fallback` is where an unset auth starts — a collection
// has none by default, a request inherits one.
export function authFormState(
  auth: CollectionAuth | Auth | null | undefined, fallback = 'none',
): AuthForm {
  const base: AuthForm = {
    type: fallback, token: '{{token}}', prefix: 'Bearer', header: 'X-API-Key', value: '{{token}}',
  };
  if (!auth) return base;
  if (typeof auth === 'string') {
    // Legacy raw Authorization value, e.g. "Bearer {{token}}".
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return { ...base, type: 'bearer', token: m[1]! };
    return auth.trim() ? { ...base, type: 'apikey', header: 'Authorization', value: auth } : base;
  }
  return { ...base, ...auth };
}

// Keep only the fields the chosen type uses. A stored auth still carrying the
// token from a type you switched away from reads as if that token were live.
export function authToStore(form: AuthForm): Auth {
  if (form.type === 'bearer') return { type: 'bearer', token: form.token, prefix: form.prefix };
  if (form.type === 'apikey') return { type: 'apikey', header: form.header, value: form.value };
  return { type: form.type as 'inherit' | 'none' };
}

// What authentication a request will actually send, without revealing the
// secret: the header it lands in, the still-unsubstituted expression behind it
// ({{token}}, not the token), and whether that expression resolves.
//   source 'request'    — a Headers-tab row sets the header directly, which
//                         beats both settings below
//   source 'own'        — the request's own auth, in place of the collection's
//   source 'collection' — the collection default applies
//   source 'none'       — nothing will be added
//   source 'off'        — the request refuses the collection default
export function describeAuth(
  collection: Collection | null | undefined, request: HttpRequest, vars: Vars,
): AuthDescription {
  const ca = authHeader(collection && collection.auth);
  const type = requestAuthType(request);
  const ra = type === 'bearer' || type === 'apikey' ? authHeader(request.auth) : null;

  // The header this request is aiming at, so a row on the Headers tab that
  // fills it in directly can be recognised as taking over.
  const target = ra || (type === 'inherit' ? ca : null);
  const own = (request.headers || []).find((h) => {
    if (h.enabled === false || !h.key) return false;
    const k = h.key.trim().toLowerCase();
    // With nothing else aiming anywhere, a plain Authorization header is it.
    return target ? k === target.name.toLowerCase() : k === 'authorization';
  });

  const nothing = (source: AuthDescription['source']): AuthDescription =>
    ({ source, headerName: null, expr: '', resolved: false, missing: [] });

  let info: { source: AuthDescription['source']; headerName: string; expr: string };
  // A header the request sets itself is sent either way — the type below only
  // decides between the collection's auth, the request's own, and neither.
  if (own) info = { source: 'request', headerName: own.key.trim(), expr: own.value || '' };
  else if (type === 'none') return nothing(ca ? 'off' : 'none');
  else if (ra) info = { source: 'own', headerName: ra.name, expr: ra.value };
  // Its own auth, chosen but not filled in: say so as an empty value rather
  // than reporting the collection's, which is not what will be sent.
  else if (type !== 'inherit') return nothing('own');
  else if (ca) info = { source: 'collection', headerName: ca.name, expr: ca.value };
  else return nothing('none');

  const value = substitute(info.expr, vars);
  const missing = unresolvedVarNames(value);
  return { ...info, resolved: !!value.trim() && missing.length === 0, missing };
}
