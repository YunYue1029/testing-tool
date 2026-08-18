// {{var}} resolution and request building.
//
// This is the authoritative copy: whatever actually gets sent is built here.
// The client keeps its own copy of these rules (client/src/util.ts) purely to
// preview a URL while you type, which can't afford a round trip per keystroke —
// but nothing is sent from that path, so the two cannot disagree about what
// left the machine.
import type {
  Auth, AuthType, Collection, CollectionAuth, Environment, Folder, HeaderPair,
  Row, RunnableRequest, Vars,
} from './types.ts';

// Matches {{var}} tokens; group 1 is the variable name.
const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

// Shared default for {{base_url}} when no environment defines it — the API
// under test, assumed to be on this machine's port 8000.
const DEFAULT_BASE_URL = 'http://localhost:8000';

// Replace {{var}} tokens using the given variables map. Unknown tokens are left as-is.
// The null passthrough is kept because callers hand it fields straight off
// stored records, which a hand-edited file can leave unset.
function substitute(str: string, vars: Vars): string;
function substitute(str: string | null | undefined, vars: Vars): string | null | undefined;
function substitute(str: string | null | undefined, vars: Vars): string | null | undefined {
  if (str == null) return str;
  return String(str).replace(VAR_RE, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : m
  );
}

// Convert an array of {key,value,enabled} rows into an object of enabled entries.
function rowsToObject(rows: Row[] | undefined, vars: Vars = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows || []) {
    if (r.enabled === false) continue;
    if (!r.key) continue;
    out[substitute(r.key, vars)] = substitute(r.value, vars);
  }
  return out;
}

// A request's own variable values, as {key: value}. These live on the request
// so an id only one call cares about (the {{user_id}} of a fetch-one) doesn't
// have to be declared in an environment everything else carries. A row with no
// value is skipped, which is how it falls back to the environment again.
function requestVars(request: { vars?: Row[] } | null | undefined): Vars {
  const out: Vars = {};
  for (const r of (request && request.vars) || []) {
    if (r.enabled === false) continue;
    if (!r.key || r.value == null || r.value === '') continue;
    out[r.key] = r.value;
  }
  return out;
}

// Collapse runs of duplicate slashes while keeping the "://" after the scheme.
function collapseSlashes(u: string | null | undefined): string {
  return String(u || '').replace(/([^:])\/{2,}/g, '$1/');
}

// The folders from the collection root down to `folderId` (root-first).
function folderChain(folders: Folder[] | undefined, folderId: string | null | undefined): Folder[] {
  const byId = new Map((folders || []).map((f) => [f.id, f]));
  const chain: Folder[] = [];
  const seen = new Set<string>();
  let cur = folderId ? byId.get(folderId) : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return chain;
}

// "Parent / Child" name path for a folder id (empty string for the root).
function folderPath(folders: Folder[] | undefined, folderId: string | null | undefined): string {
  return folderChain(folders, folderId).map((f) => f.name).join(' / ');
}

// What {{dy_url}} expands to for a request in the given folder:
//   {{base_url}} / folder1 / folder2 …  (folder names form the path)
function dyUrl(folders: Folder[] | undefined, folderId: string | null | undefined): string {
  const segs = folderChain(folders, folderId)
    .map((f) => (f.name || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return ['{{base_url}}', ...segs].join('/');
}

// Expand the {{dy_url}} token to {{base_url}} + folder path. A url without the
// token is returned unchanged (folders only affect requests that opt in).
// A url without the token comes back exactly as it was handed over, undefined
// included — folders only affect requests that opt in.
function composeUrl(
  folders: Folder[] | undefined, folderId: string | null | undefined, requestUrl: string,
): string;
function composeUrl(
  folders: Folder[] | undefined, folderId: string | null | undefined,
  requestUrl: string | undefined,
): string | undefined;
function composeUrl(
  folders: Folder[] | undefined,
  folderId: string | null | undefined,
  requestUrl: string | undefined,
): string | undefined {
  const u = requestUrl || '';
  if (!/\{\{\s*dy_url\s*\}\}/.test(u)) return requestUrl;
  return u.replace(/\{\{\s*dy_url\s*\}\}/g, dyUrl(folders, folderId));
}

// Build a URL from a raw url + query-param rows, substituting variables.
function buildUrl(rawUrl: string, paramRows: Row[] | undefined, vars: Vars): string {
  const url = collapseSlashes(substitute(rawUrl, vars));
  const params = rowsToObject(paramRows, vars);
  const keys = Object.keys(params);
  if (keys.length === 0) return url;
  const qs = keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join('&');
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

// Resolve a collection's auth setting into { name, value } (value may still
// contain {{tokens}}), or null when off.
function authHeader(auth: CollectionAuth | Auth | null | undefined): HeaderPair | null {
  if (!auth) return null;
  if (typeof auth === 'string') {
    return auth.trim() ? { name: 'Authorization', value: auth } : null;
  }
  switch (auth.type) {
    case 'bearer': {
      const token = (auth.token || '').trim();
      if (!token) return null;
      const prefix = auth.prefix != null ? auth.prefix : 'Bearer';
      return { name: 'Authorization', value: prefix ? `${prefix} ${token}` : token };
    }
    case 'apikey': {
      const name = (auth.header || '').trim();
      const value = auth.value || '';
      if (!name || !value.trim()) return null;
      return { name, value };
    }
    default:
      return null;
  }
}

// Which of the two auth settings a request runs under.
//   'inherit'          — whatever the collection defaults to (the usual case)
//   'none'             — nothing, whatever the collection says: what a login needs
//   'bearer'/'apikey'  — the request's own, in place of the collection's
// `noAuth: true` is the older spelling of 'none', still on requests saved
// before a request could carry auth of its own.
function requestAuthType(request: RunnableRequest | null | undefined): AuthType {
  const type = request && 'auth' in request && request.auth && request.auth.type;
  if (type) return type;
  return request && 'noAuth' in request && request.noAuth ? 'none' : 'inherit';
}

// The auth header a request actually sends, or null for none.
function requestAuthHeader(
  collection: Collection | null | undefined,
  request: RunnableRequest,
): HeaderPair | null {
  const type = requestAuthType(request);
  if (type === 'none') return null;
  if (type === 'inherit') return authHeader(collection && collection.auth);
  return authHeader('auth' in request ? request.auth : null);
}

// Override {{base_url}} with the collection's own baseUrl, when set. The
// collection value may itself contain {{vars}}, so an environment can still
// steer it indirectly.
function applyCollectionBaseUrl(
  vars: Vars,
  // Only baseUrl is read, so that is all this asks for.
  collection: Pick<Collection, 'baseUrl'> | { baseUrl?: string } | null | undefined,
): Vars {
  const raw = collection && typeof collection.baseUrl === 'string' ? collection.baseUrl.trim() : '';
  if (!raw) return vars;
  return { ...vars, base_url: substitute(raw, vars) };
}

// Build a {key: value} substitution map from an environment record, excluding
// keys listed in `disabled`.
function envVars(
  env: { variables?: Record<string, string>; disabled?: string[] } | null | undefined,
): Vars {
  if (!env || typeof env.variables !== 'object') return {};
  const disabled = new Set(env.disabled || []);
  const vars: Vars = {};
  for (const [k, v] of Object.entries(env.variables)) {
    if (disabled.has(k)) continue;
    vars[k] = v;
  }
  return vars;
}

export {
  VAR_RE, DEFAULT_BASE_URL, substitute, rowsToObject, requestVars, collapseSlashes,
  folderChain, folderPath, dyUrl, composeUrl, buildUrl, authHeader,
  requestAuthType, requestAuthHeader, applyCollectionBaseUrl, envVars,
};
