// Collections: the catalogue of an API's endpoints, its folders (which are
// {{dy_url}} path segments) and the base_url they resolve against.
import { z } from 'zod';
import { api } from '../api.ts';
import { newId } from '../../server/ids.ts';
import { folderPath } from '../../server/resolve.ts';
import type { Folder } from '../../server/types.ts';
import { requireCollection, requireFolder } from '../shape.ts';
import type { Tool } from '../server.ts';

export function register(tool: Tool): void {
  tool('list_collections', {
    title: 'List collections',
    description:
      'List collections: collection_id, name, base_url, request_count, updated_at. No request ' +
      'contents.',
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
      'One collection\'s folders (folder_id, path) and endpoints (request_id, name, method, url, ' +
      'folder_id; a shell test shows kind and command instead). No bodies, headers or scripts — ' +
      'get_request has those.',
    inputSchema: { collection_id: z.string() },
  }, async ({ collection_id }) => {
    const c = await requireCollection(collection_id);
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

  tool('search_requests', {
    title: 'Search requests',
    description:
      'Find saved requests across all collections by name, url or command (case-insensitive ' +
      'substring); lightweight matches with ids.',
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

  tool('create_collection', {
    title: 'Create a collection',
    description:
      'Create an empty collection. Without base_url it reads {{<name>_url}} from the environment — ' +
      'added, empty, to every environment; fill it in with set_env_var. Pass base_url only to pin ' +
      'something else.',
    inputSchema: { name: z.string(), base_url: z.string().optional() },
  }, async ({ name, base_url }) => {
    const c = await api.createCollection({ name, baseUrl: base_url || '' });
    return { collection_id: c.id, name: c.name, base_url: c.baseUrl || null, requests: [], updated_at: c.updatedAt };
  });

  tool('set_collection_base_url', {
    title: 'Set a collection base URL',
    description:
      'Set (or clear with "") the collection\'s own base_url, the first thing base_url resolution ' +
      'tries; it may contain {{vars}}.',
    inputSchema: { collection_id: z.string(), base_url: z.string() },
  }, async ({ collection_id, base_url }) => {
    // The PATCH answers a wrong id with a bare "Not found", which is why it is
    // still looked up first.
    const c = await requireCollection(collection_id);
    const saved = await api.patchCollection(c.id, { baseUrl: base_url });
    return { collection_id: saved.id, name: saved.name, base_url: saved.baseUrl || null };
  });

  tool('create_folder', {
    title: 'Create a folder',
    description:
      'Create a folder in a collection (nest with parent_folder_id). Its name becomes a {{dy_url}} ' +
      'path segment; returns folder_id for save_request.',
    inputSchema: {
      collection_id: z.string(),
      name: z.string(),
      parent_folder_id: z.string().optional(),
    },
  }, async ({ collection_id, name, parent_folder_id }) => {
    const c = await requireCollection(collection_id);
    if (parent_folder_id) requireFolder(c, parent_folder_id);
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

  tool('delete_folder', {
    title: 'Delete a folder',
    description:
      'Delete a folder with the folders nested inside it and every request in any of them; the ' +
      'reply lists what went. To keep the requests, move them out first with save_request ' +
      'folder_id.',
    inputSchema: { collection_id: z.string(), folder_id: z.string() },
  }, async ({ collection_id, folder_id }) => {
    const before = await requireCollection(collection_id);
    requireFolder(before, folder_id);
    const path = folderPath(before.folders, folder_id);
    const after = await api.deleteFolder(before.id, folder_id);
    // Reported by comparing before with after rather than by working the
    // subtree out again here, so this says what the backend really removed.
    const goneFolders = (before.folders || [])
      .filter((f) => !(after.folders || []).some((g) => g.id === f.id));
    const goneRequests = (before.requests || [])
      .filter((r) => !(after.requests || []).some((x) => x.id === r.id));
    return {
      collection_id: after.id,
      deleted_folder_id: folder_id,
      path,
      deleted_folders: goneFolders.map((f) => ({ folder_id: f.id, name: f.name })),
      deleted_requests: goneRequests.map((r) => ({ request_id: r.id, name: r.name })),
    };
  });

  tool('delete_collection', {
    title: 'Delete a collection',
    description:
      'Delete a whole collection — every folder, request and shell test in it; prefer ' +
      'delete_request or delete_folder unless the collection itself is going. used_by_flows lists ' +
      'the flow steps that pointed into it.',
    inputSchema: { collection_id: z.string() },
  }, async ({ collection_id }) => {
    const c = await requireCollection(collection_id);
    const flows = await api.listFlows();
    const usedBy = flows.flatMap((f) => (f.steps || [])
      .filter((s) => s.collectionId === c.id)
      .map((s) => ({ flow_id: f.id, flow: f.name, step_id: s.id, step: s.name })));
    const res = await api.deleteCollection(c.id);
    return {
      deleted_collection_id: c.id,
      name: c.name,
      deleted_requests: (c.requests || []).length,
      deleted_folders: (c.folders || []).length,
      ok: res.ok,
      used_by_flows: usedBy,
    };
  });
}
