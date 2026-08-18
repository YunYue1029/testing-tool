// Convert a Postman collection export (v2.x) into this app's data model.
//
// The point of the import is to land in a shape this app can actually work
// with, which means three things beyond copying requests across:
//
//   1. Postman's folder tree becomes our folder tree. Ours doubles as the route
//      tree, but a folder only affects a URL that opts in with {{dy_url}}, so
//      carrying prose folder names ("User Management") over is safe.
//   2. The host every request shares is lifted into the collection's base_url
//      and replaced with {{base_url}}. That is what makes the imported
//      collection point at another environment without editing every request.
//   3. A url is rewritten to {{dy_url}} only when the folder names it sits in
//      really are the leading path segments — true of a route-shaped export,
//      and left alone otherwise rather than guessed at.
import type {
  CollectionAuth, CollectionInput, EnvironmentInput, Folder, FormRow,
  HttpRequest, Row,
} from './types.ts';

// ---- The slice of Postman's export format this reads ----
// Everything is optional: an export is someone else's file, and the whole job
// here is to cope with whichever fields it happens to carry.
interface PmRow {
  key?: string;
  value?: unknown;
  // Collection rows carry `disabled`, environment values carry `enabled`.
  disabled?: boolean;
  enabled?: boolean;
  type?: string;
  src?: string;
}
interface PmUrl {
  raw?: string;
  query?: PmRow[];
}
interface PmBody {
  mode?: string;
  raw?: string;
  options?: { raw?: { language?: string } };
  urlencoded?: PmRow[];
  formdata?: PmRow[];
}
interface PmRequest {
  url?: string | PmUrl;
  method?: string;
  header?: PmRow[];
  body?: PmBody;
}
export interface PmItem {
  name?: string;
  item?: PmItem[];
  request?: string | PmRequest;
}
interface PmAuth {
  type?: string;
  bearer?: PmRow[];
  apikey?: PmRow[];
}
export interface PmCollection {
  info?: { name?: string };
  item?: PmItem[];
  auth?: PmAuth;
}
export interface PmEnvironment {
  name?: string;
  values?: PmRow[];
}

// What one converted export looks like. Narrower than CollectionInput on
// purpose: an import never produces a shell test, and the tests read `.url` off
// what comes back.
export interface ImportedCollection extends CollectionInput {
  name: string;
  baseUrl: string;
  auth: CollectionAuth;
  folders: Folder[];
  requests: HttpRequest[];
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function row(key: string | undefined, value: unknown, enabled = true): Row {
  return { key: key || '', value: value == null ? '' : String(value), enabled };
}

// Split a Postman url into the part that identifies the host and the rest.
// The host is either a literal origin or, very often, a {{variable}}.
function splitOrigin(raw: string | undefined): { origin: string; rest: string } {
  const m = /^(\{\{\s*[\w.-]+\s*\}\}|https?:\/\/[^/?#]+)(.*)$/i.exec(raw || '');
  return m ? { origin: m[1]!, rest: m[2] || '' } : { origin: '', rest: raw || '' };
}

// Replace the leading {{base_url}}/a/b with {{dy_url}} when a, b are exactly
// the folders the request sits in. Returns the url unchanged when they are not.
function useDyUrl(url: string, folderNames: string[]): string {
  const BASE = '{{base_url}}';
  if (!folderNames.length || !url.startsWith(BASE)) return url;
  const rest = url.slice(BASE.length);
  const prefix = folderNames.map((n) => `/${n}`).join('');
  if (rest !== prefix && !rest.startsWith(`${prefix}/`)) return url;
  return `{{dy_url}}${rest.slice(prefix.length)}`;
}

// The query string as Postman wrote it into the url. v2.0 exports, and any item
// whose url is a plain string, carry no `query` array to read it out of — so
// without this the params would be dropped along with the rest of the `?`.
// Values come back decoded, which is the form the sender re-encodes from.
function paramsFromRaw(raw: string): Row[] {
  const qIdx = raw.indexOf('?');
  if (qIdx === -1) return [];
  const qs = raw.slice(qIdx + 1).split('#')[0]!;
  return [...new URLSearchParams(qs)].map(([k, v]) => row(k, v));
}

function convertRequest(item: PmItem, folderId: string | null): HttpRequest {
  const r: PmRequest = typeof item.request === 'string'
    ? { url: item.request, method: 'GET' }
    : (item.request || {});
  const urlObj: PmUrl = typeof r.url === 'string' ? { raw: r.url } : (r.url || {});
  const raw = urlObj.raw || '';

  // The query string lives in editable param rows, not in the URL itself.
  const qIdx = raw.indexOf('?');
  const url = qIdx === -1 ? raw : raw.slice(0, qIdx);
  let params = (urlObj.query || []).map((q) => row(q.key, q.value, q.disabled !== true));
  if (!params.length) params = paramsFromRaw(raw);
  const headers = (r.header || []).map((h) => row(h.key, h.value, h.disabled !== true));

  let bodyType: HttpRequest['bodyType'] = 'none';
  let content = '';
  let form: FormRow[] | null = null;
  const b: PmBody = r.body || {};
  if (b.mode === 'raw' && b.raw != null) {
    content = b.raw;
    const lang = b.options && b.options.raw && b.options.raw.language;
    bodyType = lang === 'json' || /^\s*[[{]/.test(b.raw) ? 'json' : 'text';
  } else if (b.mode === 'urlencoded') {
    content = (b.urlencoded || [])
      .filter((f) => f.disabled !== true && f.key)
      .map((f) => `${f.key}=${f.value == null ? '' : f.value}`)
      .join('&');
    bodyType = 'text';
    if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) {
      headers.push(row('Content-Type', 'application/x-www-form-urlencoded'));
    }
  } else if (b.mode === 'formdata') {
    // Real multipart rows. A file field's bytes aren't in the export (Postman
    // only records the exporting machine's path), so the row is created empty
    // and keeps the original path as a hint for which file to attach.
    form = (b.formdata || [])
      .filter((f) => f.key)
      .map((f): FormRow => (f.type === 'file'
        ? { key: f.key!, type: 'file', value: '', enabled: f.disabled !== true, fileHint: f.src || '' }
        : { key: f.key!, type: 'text', value: f.value == null ? '' : String(f.value), enabled: f.disabled !== true }));
    form.push({ key: '', type: 'text', value: '', enabled: true });
    bodyType = 'form';
  }

  params.push(row('', ''));
  headers.push(row('', ''));
  const body = { id: uid(), name: 'Default', content };
  return {
    id: uid(),
    name: item.name || 'Untitled',
    method: (r.method || 'GET').toUpperCase(),
    url,
    folderId: folderId || null,
    params,
    headers,
    bodyType,
    bodies: [body],
    activeBodyId: body.id,
    ...(form ? { form } : {}),
    script: '',
  };
}

interface WalkOut {
  folders: Folder[];
  requests: HttpRequest[];
  folderNames: Map<string, string[]>;
}

// Walk Postman's item tree, mirroring its folders into ours. `names` is the
// chain of folder names down to here, kept so a url can later be matched
// against it.
function walk(
  items: PmItem[] | undefined,
  parentId: string | null,
  names: string[],
  out: WalkOut,
): void {
  for (const it of items || []) {
    if (Array.isArray(it.item)) {
      const folder: Folder = { id: uid(), name: it.name || 'Untitled', parentId };
      out.folders.push(folder);
      walk(it.item, folder.id, [...names, folder.name], out);
    } else if (it.request) {
      out.requests.push(convertRequest(it, parentId));
      out.folderNames.set(out.requests[out.requests.length - 1]!.id, names);
    }
  }
}

// Postman's collection-level auth, mapped onto ours. Anything else (oauth2,
// awsv4, …) has no equivalent here and is left off rather than half-applied.
function convertAuth(auth: PmAuth | undefined): CollectionAuth {
  if (!auth || typeof auth !== 'object') return '';
  const val = (list: PmRow[] | undefined, key: string): string => {
    const hit = (list || []).find((x) => x.key === key);
    return hit && hit.value != null ? String(hit.value) : '';
  };
  if (auth.type === 'bearer') {
    const token = val(auth.bearer, 'token');
    return token ? { type: 'bearer', token } : '';
  }
  if (auth.type === 'apikey') {
    const header = val(auth.apikey, 'key');
    const value = val(auth.apikey, 'value');
    // Postman can put an api key in the query string; we only do headers.
    const inQuery = val(auth.apikey, 'in') === 'query';
    return header && value && !inQuery ? { type: 'apikey', header, value } : '';
  }
  return '';
}

// The host to lift into base_url: whichever one the most requests share. A
// collection pointing at two hosts keeps the odd one out spelled in full.
function dominantOrigin(requests: HttpRequest[]): string {
  const counts = new Map<string, number>();
  for (const r of requests) {
    const { origin } = splitOrigin(r.url);
    if (origin) counts.set(origin, (counts.get(origin) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [origin, n] of counts) {
    if (n > bestCount) { best = origin; bestCount = n; }
  }
  return best;
}

// Returns [{ name, baseUrl, auth, folders, requests }] ready for collections.save().
// Still an array: an export could in principle be split, and the caller loops.
function convertPostmanCollection(pm: PmCollection): ImportedCollection[] {
  const out: WalkOut = { folders: [], requests: [], folderNames: new Map() };
  walk(pm.item, null, [], out);

  const baseUrl = dominantOrigin(out.requests);
  for (const r of out.requests) {
    const { origin, rest } = splitOrigin(r.url);
    // A request on another host keeps its absolute url; nothing to gain from
    // pointing it at a base_url that isn't its own.
    if (!baseUrl || origin !== baseUrl) continue;
    r.url = useDyUrl(`{{base_url}}${rest}`, out.folderNames.get(r.id) || []);
  }

  return [{
    name: (pm.info && pm.info.name) || 'Imported',
    baseUrl,
    auth: convertAuth(pm.auth),
    folders: out.folders,
    requests: out.requests,
  }];
}

// Postman environment export: { name, values: [{key, value, enabled}] }.
function convertPostmanEnvironment(pm: PmEnvironment): EnvironmentInput {
  const variables: Record<string, string> = {};
  const disabled: string[] = [];
  for (const v of pm.values || []) {
    if (!v.key) continue;
    variables[v.key] = v.value == null ? '' : String(v.value);
    if (v.enabled === false) disabled.push(v.key);
  }
  return { name: pm.name || 'Imported Environment', variables, disabled };
}

export { convertPostmanCollection, convertPostmanEnvironment };
