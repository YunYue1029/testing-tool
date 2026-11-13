// Thin HTTP client for the testing-tool backend (server/index.ts).
// Base URL comes from TESTING_TOOL_URL (default http://localhost:7620).
// API_TEST_URL is the pre-rename name, still read so existing shells and
// client configs keep working.
//
// The domain types come from the server itself rather than a copy kept here:
// this client speaks that API, and a second definition of Collection would only
// be a second thing to keep in step. `import type` is erased outright, so
// nothing is loaded across the package boundary at run time.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Collection, CollectionInput, Environment, EnvironmentInput, FileMeta, Flow, FlowInput,
  FlowReport, Folder, HttpRunResult, Overrides, SavedRequest, ShellRunResult, Vars,
} from '../server/types.ts';

// The Content-Type an upload is stored under, which is the type its form part
// goes out with. A backend that checks for image/png rejects
// application/octet-stream, so the common ones are named; anything else stays
// generic.
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv',
  '.html': 'text/html', '.xml': 'application/xml', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const BASE = (
  process.env.TESTING_TOOL_URL || process.env.API_TEST_URL || 'http://localhost:7620'
).replace(/\/+$/, '');

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause || {};
    throw new Error(
      `Cannot reach the testing-tool backend at ${BASE} (${cause.code || (err as Error).message}). ` +
      'Is it running?  (npm run dev  or  npm start)'
    );
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json() as { error?: string; hint?: string };
      if (data.error) msg = data.error;
      if (data.hint) msg += ` — ${data.hint}`;
    } catch { /* non-JSON error body */ }
    throw new Error(msg);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

// What /api/run accepts: a stored request by id, or one that exists nowhere.
export interface RunPayload {
  collection_id?: string;
  request_id?: string;
  request?: SavedRequest;
  environment?: string | undefined;
  vars?: Vars;
  overrides?: Overrides | undefined;
  timeout?: number;
}

export const api = {
  base: BASE,
  // Resolve + send + run the script, all on the backend, so this server can't
  // drift from what the app sends. Every tool that sends anything goes through
  // here, ad-hoc requests included.
  run: (payload: RunPayload) =>
    request<HttpRunResult | ShellRunResult>('POST', '/api/run', payload),

  // A file on this machine, stored by the backend for a form-data file field —
  // the same /api/files the app's "Choose file" posts to, raw bytes as the
  // body. The path is read here, so it is a path on the machine this MCP
  // server runs on.
  uploadFile: async (filePath: string): Promise<FileMeta> => {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`File path must be absolute: "${filePath}"`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (err) {
      throw new Error(`Cannot read "${filePath}": ${(err as Error).message}`);
    }
    if (!bytes.length) throw new Error(`"${filePath}" is empty — the backend refuses an empty upload.`);
    const name = path.basename(filePath);
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/files?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream' },
        body: new Uint8Array(bytes),
      });
    } catch (err) {
      throw new Error(`Cannot reach the testing-tool backend at ${BASE} (${(err as Error).message}).`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`Upload of "${name}" failed: ${data.error || `${res.status} ${res.statusText}`}`);
    }
    return await res.json() as FileMeta;
  },

  listCollections: () => request<Collection[]>('GET', '/api/collections'),
  getCollection: (id: string) =>
    request<Collection | null>('GET', `/api/collections/${encodeURIComponent(id)}`),
  createCollection: (c: CollectionInput) => request<Collection>('POST', '/api/collections', c),

  // Partial edits — the server merges each into the current document. Sending
  // a whole collection back would overwrite anything changed in the app since
  // this process read it, which is easy to hit when a person is working in the
  // UI while we write. All of these return the updated collection.
  patchCollection: (id: string, fields: Partial<Pick<Collection, 'name' | 'auth' | 'baseUrl'>>) =>
    request<Collection>('PATCH', `/api/collections/${encodeURIComponent(id)}`, fields),
  putRequest: (colId: string, r: SavedRequest) =>
    request<Collection>('PUT', `/api/collections/${encodeURIComponent(colId)}/requests/${encodeURIComponent(r.id)}`, r),
  // Answers with the collection either way: the backend filters the request
  // out, so an id that was never there is not an error to it.
  deleteRequest: (colId: string, requestId: string) =>
    request<Collection>('DELETE', `/api/collections/${encodeURIComponent(colId)}/requests/${encodeURIComponent(requestId)}`),
  createFolder: (colId: string, folder: Folder) =>
    request<Collection>('POST', `/api/collections/${encodeURIComponent(colId)}/folders`, folder),
  // Takes the folders nested under it and every request filed in any of them,
  // in one write. Answers with the collection as it stands after.
  deleteFolder: (colId: string, folderId: string) =>
    request<Collection>('DELETE', `/api/collections/${encodeURIComponent(colId)}/folders/${encodeURIComponent(folderId)}`),
  deleteCollection: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/collections/${encodeURIComponent(id)}`),

  listFlows: () => request<Flow[]>('GET', '/api/flows'),
  getFlow: (id: string) => request<Flow | null>('GET', `/api/flows/${encodeURIComponent(id)}`),
  createFlow: (f: FlowInput) => request<Flow>('POST', '/api/flows', f),
  updateFlow: (id: string, f: FlowInput) =>
    request<Flow>('PUT', `/api/flows/${encodeURIComponent(id)}`, f),
  runFlow: (id: string, payload: { environment?: string }) =>
    request<FlowReport>('POST', `/api/flows/${encodeURIComponent(id)}/run`, payload),
  deleteFlow: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/flows/${encodeURIComponent(id)}`),
  listFlowFolders: () => request<Folder[]>('GET', '/api/flow-folders'),
  createFlowFolder: (folder: Omit<Folder, 'id'> & { id?: string }) =>
    request<{ folder: Folder; folders: Folder[] }>('POST', '/api/flow-folders', folder),
  // Flows are separate documents, so this cannot be one atomic write; the
  // backend removes the flows first and reports which ones went.
  deleteFlowFolder: (id: string) =>
    request<{ folders: Folder[]; deletedFlows: string[] }>('DELETE', `/api/flow-folders/${encodeURIComponent(id)}`),

  listEnvironments: () => request<Environment[]>('GET', '/api/environments'),
  updateEnvironment: (id: string, e: EnvironmentInput) =>
    request<Environment>('PUT', `/api/environments/${encodeURIComponent(id)}`, e),
  deleteEnvironment: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/environments/${encodeURIComponent(id)}`),
};
