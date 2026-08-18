// Thin wrapper around the backend API.
import type {
  Collection, Environment, FileMeta, Flow, FlowReport, Folder, HttpRequest,
  SavedRequest, Vars,
} from './types.ts';
import type { HttpRunResult, ShellRunResult } from '../../server/types.ts';

async function j<T>(
  method: string, url: string, body?: unknown, signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json() as { error?: string; hint?: string };
      msg = data.error || msg;
      if (data.hint) msg += `\n\n${data.hint}`;
    } catch {}
    throw new Error(msg);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

// Raw upload — the file's bytes are the request body, so nothing has to be
// base64-encoded or wrapped in a multipart envelope on the way to our server.
async function uploadFile(file: File): Promise<FileMeta> {
  const res = await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<FileMeta>;
}

const includeQuery = (include?: string[]): string =>
  (Array.isArray(include) && include.length ? `?include=${include.join(',')}` : '');

export interface RunPayload {
  collection_id?: string | null;
  request_id?: string;
  request?: SavedRequest;
  environment?: string | null;
  vars?: Vars;
  overrides?: { url?: string; headers?: Record<string, string>; body?: string };
  timeout?: number;
}

export const api = {
  // `signal` lets the UI cancel an in-flight request; the backend sees the
  // disconnect and drops its own call to the target.
  //
  // Run a request the way it is stored: the server resolves {{vars}}, expands
  // {{dy_url}}, applies the collection's auth, picks the body and runs the
  // post-response script. Doing that here as well is how the app and MCP
  // drifted apart over what actually gets sent.
  run: (payload: RunPayload, signal?: AbortSignal) =>
    j<HttpRunResult | ShellRunResult>('POST', '/api/run', payload, signal),
  uploadFile,

  listCollections: () => j<Collection[]>('GET', '/api/collections'),
  createCollection: (c: Partial<Collection>) => j<Collection>('POST', '/api/collections', c),
  deleteCollection: (id: string) => j<{ ok: boolean }>('DELETE', `/api/collections/${id}`),

  // Partial edits. Each names the one thing that changes, so the server merges
  // it into the current document instead of taking our copy as the truth —
  // sending the whole collection let a stale snapshot silently undo whatever
  // had changed elsewhere in it. All of these return the updated collection.
  patchCollection: (id: string, fields: Partial<Collection>) =>
    j<Collection>('PATCH', `/api/collections/${id}`, fields),
  putRequest: (colId: string, request: SavedRequest) =>
    j<Collection>('PUT', `/api/collections/${colId}/requests/${request.id}`, request),
  patchRequest: (colId: string, rid: string, fields: Partial<SavedRequest>) =>
    j<Collection>('PATCH', `/api/collections/${colId}/requests/${rid}`, fields),
  deleteRequest: (colId: string, rid: string) =>
    j<Collection>('DELETE', `/api/collections/${colId}/requests/${rid}`),
  createFolder: (colId: string, folder: Folder) =>
    j<Collection>('POST', `/api/collections/${colId}/folders`, folder),
  patchFolder: (colId: string, fid: string, fields: Partial<Folder>) =>
    j<Collection>('PATCH', `/api/collections/${colId}/folders/${fid}`, fields),
  deleteFolder: (colId: string, fid: string) =>
    j<Collection>('DELETE', `/api/collections/${colId}/folders/${fid}`),

  listEnvironments: () => j<Environment[]>('GET', '/api/environments'),
  saveEnvironment: (e: Partial<Environment>) => (e.id
    ? j<Environment>('PUT', `/api/environments/${e.id}`, e)
    : j<Environment>('POST', '/api/environments', e)),
  deleteEnvironment: (id: string) => j<{ ok: boolean }>('DELETE', `/api/environments/${id}`),

  // Flows are one editing unit, so they are written whole — the per-item
  // endpoints collections need are for documents edited from several places.
  listFlows: () => j<Flow[]>('GET', '/api/flows'),
  saveFlow: (f: Partial<Flow>) =>
    (f.id ? j<Flow>('PUT', `/api/flows/${f.id}`, f) : j<Flow>('POST', '/api/flows', f)),
  deleteFlow: (id: string) => j<{ ok: boolean }>('DELETE', `/api/flows/${id}`),
  runFlow: (id: string, payload?: { environment?: string | null }, signal?: AbortSignal) =>
    j<FlowReport>('POST', `/api/flows/${id}/run`, payload || {}, signal),
  runFlowStep: (
    id: string, stepId: string, payload?: { environment?: string | null }, signal?: AbortSignal,
  ) => j<FlowReport>('POST', `/api/flows/${id}/steps/${stepId}/run`, payload || {}, signal),

  // The tree flows are filed under. Its own endpoints, because a folder is not
  // part of any one flow — it outlives the flows put in it.
  listFlowFolders: () => j<Folder[]>('GET', '/api/flow-folders'),
  createFlowFolder: (folder: Partial<Folder>) =>
    j<{ folder: Folder; folders: Folder[] }>('POST', '/api/flow-folders', folder),
  patchFlowFolder: (id: string, fields: Partial<Folder>) =>
    j<Folder[]>('PATCH', `/api/flow-folders/${id}`, fields),
  deleteFlowFolder: (id: string) =>
    j<{ folders: Folder[]; deletedFlows: string[] }>('DELETE', `/api/flow-folders/${id}`),

  listBaseUrls: () => j<string[]>('GET', '/api/base-urls'),
  saveBaseUrls: (list: string[]) => j<string[]>('PUT', '/api/base-urls', list),

  // Cheap "has anything changed?" — a counter held in the server's memory, so
  // a tab can ask every few seconds without touching the disk.
  getRev: () => j<{ startedAt: number; rev: number }>('GET', '/api/rev'),

  importPostman: (data: unknown) => j<Record<string, unknown>>('POST', '/api/import/postman', data),

  // This workspace as one file, and back again — how a second machine gets the
  // same tests, environments and flows. `include` is the picked sections
  // (['tests','flows','environments']); leaving it off means everything.
  exportAll: (include?: string[]) =>
    j<Record<string, unknown>>('GET', `/api/export${includeQuery(include)}`),
  importWorkspace: (data: unknown, include?: string[]) =>
    j<Record<string, unknown>>('POST', `/api/import/workspace${includeQuery(include)}`, data),
};
