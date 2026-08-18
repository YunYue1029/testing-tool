import express from 'express';
import type { ErrorRequestHandler, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import {
  ensureDirs, collections, environments, flows, flowFolders, migrateFlowGroups,
  baseUrls, files, revision, newId, DATA_DIR,
} from './store.ts';
import { convertPostmanCollection, convertPostmanEnvironment } from './postman.ts';
import { SendError, runRequest, runShellRequest } from './runner.ts';
import { runFlow } from './flow.ts';
import type {
  Collection, CollectionInput, Environment, EnvironmentInput, Flow, FlowInput,
  Folder, SavedRequest,
} from './types.ts';

const app = express();
const PORT = process.env.PORT || 3000;
// Loopback by default. /api/run happily executes a post-response script that
// came in with the request (see runScript in runner.ts — vm is not a security
// boundary), so anyone who can reach this port can run code as this process.
// HOST overrides the bind address; there is no good reason to widen it.
const HOST = process.env.HOST || '127.0.0.1';

// Postman exports carry saved example responses and run to tens of megabytes,
// so the import route gets its own generous limit. It is mounted first because
// body-parser only parses once — the ordinary limit below then sees the body as
// already read and waves it through. Everything else is small: even a 600-request
// collection is under a megabyte whole.
app.use('/api/import/postman', express.json({ limit: '100mb' }));
// The upload route claims its body for the same reason, going the other way: it
// is raw bytes, never JSON, but the browser labels a .json file
// application/json. Parsed as JSON it would reach the route as an object with
// no .length — an upload that fails as empty.
app.use('/api/files', express.raw({ type: '*/*', limit: '100mb' }));
app.use(express.json({ limit: '5mb' }));

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

const asyncH = (fn: AsyncHandler) => (req: Request, res: Response) => fn(req, res).catch((err) => {
  // A send that failed for a reportable reason (bad URL, timeout, refused
  // connection) carries its own status and message.
  if (err instanceof SendError) {
    if (err.cancelled) return undefined; // nobody left to answer
    return res.status(err.status).json({
      error: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
    });
  }
  console.error(err);
  return res.status(500).json({ error: (err as Error).message });
});

// The caller's own abort signal: when the browser gives up (Cancel, reload,
// closed tab) the upstream call should go with it.
function callerGone(req: Request): AbortSignal {
  const ac = new AbortController();
  req.on('aborted', () => ac.abort());
  return ac.signal;
}

// ---- Run a request: resolve it, send it, run its script ----
// Pass request_id to run a stored request, or `request` to run one that only
// exists in the editor. collection_id supplies the folder path for {{dy_url}},
// the default auth and the base_url override.
//
// A test of kind "shell" runs a command instead of sending anything — same
// endpoint, because from the caller's side it is the same act: run the thing
// that is saved there and tell me what it did.
app.post('/api/run', asyncH(async (req, res) => {
  const {
    collection_id: colId, request_id: rid, request: inline,
    environment, vars, overrides, timeout,
  } = req.body || {};

  const collection = colId ? await collections.get(colId) : null;
  if (colId && !collection) return res.status(404).json({ error: 'Collection not found' });

  let request: SavedRequest | undefined = inline;
  if (rid) {
    request = (collection && collection.requests || []).find((r) => r.id === rid);
    if (!request) return res.status(404).json({ error: 'Request not found' });
  }
  if (!request) return res.status(400).json({ error: 'A request or request_id is required' });

  if (request.kind === 'shell') {
    return res.json(await runShellRequest({
      collection,
      request,
      environmentId: environment || undefined,
      vars,
      timeout,
      abortSignal: callerGone(req),
    }));
  }

  return res.json(await runRequest({
    collection,
    request,
    environmentId: environment || undefined,
    vars,
    overrides,
    timeout,
    abortSignal: callerGone(req),
  }));
}));

// ---- Flows ----
// A flow is one editing unit, so it is written whole — the per-item endpoints
// collections needed are for documents several people edit at once.
app.get('/api/flows', asyncH(async (req, res) => res.json(await flows.list())));
app.get('/api/flows/:id', asyncH(async (req, res) => {
  const f = await flows.get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  return res.json(f);
}));
app.post('/api/flows', asyncH(async (req, res) => res.json(await flows.save(req.body || {}))));
app.put('/api/flows/:id', asyncH(async (req, res) =>
  res.json(await flows.save({ ...(req.body as FlowInput), id: req.params.id }))));
app.delete('/api/flows/:id', asyncH(async (req, res) =>
  res.json({ ok: await flows.remove(req.params.id) })));

app.post('/api/flows/:id/run', asyncH(async (req, res) => {
  const flow = await flows.get(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Not found' });
  const { environment } = req.body || {};
  return res.json(await runFlow(flow, {
    environmentId: environment || undefined,
    abortSignal: callerGone(req),
  }));
}));

// One step on its own, for the loop of fixing a request and trying it again
// without sitting through the ten steps in front of it. It reuses runFlow over
// a one-step flow, so assertions, extractions and the report come out identical
// to the step's entry in a full run.
//
// It starts with no run variables: whatever an earlier step captured is simply
// not there, and a step built on {{an_id_from_step_3}} will say so rather than
// quietly passing. Variables the environment defines resolve as usual.
app.post('/api/flows/:id/steps/:stepId/run', asyncH(async (req, res) => {
  const flow = await flows.get(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Not found' });
  const step = (flow.steps || []).find((s) => s.id === req.params.stepId);
  if (!step) return res.status(404).json({ error: 'No such step in this flow' });
  const { environment } = req.body || {};
  // Asking for this one step by hand is saying to run it — reporting "skipped"
  // back at someone who just pressed run would be a joke at their expense.
  return res.json(await runFlow({ ...flow, steps: [{ ...step, enabled: true }] }, {
    environmentId: environment || undefined,
    abortSignal: callerGone(req),
  }));
}));

// ---- Flow folders ----
// A tree of its own, not a collection's: flows are filed by what they test, and
// the requests they chain can come from several collections at once.
app.get('/api/flow-folders', asyncH(async (req, res) => res.json(await flowFolders.list())));

app.post('/api/flow-folders', asyncH(async (req, res) => {
  const { id, name, parentId } = req.body || {};
  const folder: Folder = { id: id || newId(), name: name || 'New Folder', parentId: parentId || null };
  const list = await flowFolders.update((cur) => [...cur, folder]);
  res.json({ folder, folders: list });
}));

app.patch('/api/flow-folders/:fid', asyncH(async (req, res) => {
  const { name, parentId } = req.body || {};
  let found = false;
  const list = await flowFolders.update((cur) => {
    const idx = cur.findIndex((f) => f.id === req.params.fid);
    if (idx < 0) return null;
    found = true;
    const next = cur.slice();
    next[idx] = {
      ...next[idx]!,
      ...(name !== undefined ? { name } : {}),
      ...(parentId !== undefined ? { parentId: parentId || null } : {}),
    };
    return next;
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  return res.json(list);
}));

// Deleting a folder takes its subtree and the flows inside with it, the way a
// collection's folder takes its requests. Flows are separate documents, so this
// cannot be one atomic write: the folders go last, leaving a failure mid-way
// with flows already gone rather than flows stranded in a folder that isn't
// there any more.
app.delete('/api/flow-folders/:fid', asyncH(async (req, res) => {
  const folders = await flowFolders.list();
  const doomed = withDescendants(folders, req.params.fid);
  const inside = (await flows.list()).filter((f) => doomed.includes(f.folderId as string));
  for (const f of inside) await flows.remove(f.id);
  const list = await flowFolders.update((cur) => cur.filter((f) => !doomed.includes(f.id)));
  res.json({ folders: list, deletedFlows: inside.map((f) => f.id) });
}));

// ---- Saved base URLs (the base-URL pick-list) ----
app.get('/api/base-urls', asyncH(async (req, res) => res.json(await baseUrls.list())));
app.put('/api/base-urls', asyncH(async (req, res) => res.json(await baseUrls.save(req.body))));

// ---- Uploaded files for form-data bodies ----
// The browser PUTs the raw bytes (no multipart wrapper needed for a single
// file), with the original filename in the query string.
app.post('/api/files', asyncH(async (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty upload' });
  const meta = await files.save(req.body, {
    name: req.query.name as string | undefined,
    type: req.get('content-type'),
  });
  res.json(meta);
}));

// ---- Collections ----
app.get('/api/collections', asyncH(async (req, res) => res.json(await collections.list())));
app.get('/api/collections/:id', asyncH(async (req, res) => {
  const c = await collections.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
}));
app.post('/api/collections', asyncH(async (req, res) => res.json(await collections.save(req.body || {}))));
app.put('/api/collections/:id', asyncH(async (req, res) =>
  res.json(await collections.save({ ...(req.body as CollectionInput), id: req.params.id }))));
app.delete('/api/collections/:id', asyncH(async (req, res) => {
  const ok = await collections.remove(req.params.id);
  res.json({ ok });
}));

// ---- Partial edits ----
// One endpoint per thing that can change, so a caller says "rename this
// request" instead of "here is the whole collection as I last saw it". Two
// people (or the UI and MCP) editing different parts no longer overwrite each
// other, because the server merges each change into the current document
// rather than replacing it. All of them answer with the updated collection.
const updated = (res: Response) => (c: Collection | null) =>
  (c ? res.json(c) : res.status(404).json({ error: 'Not found' }));

// A folder plus every folder nested beneath it.
function withDescendants(folders: Folder[] | undefined, rootId: string): string[] {
  const ids = [rootId];
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders || []) {
      if (ids.includes(f.parentId as string) && !ids.includes(f.id)) { ids.push(f.id); grew = true; }
    }
  }
  return ids;
}

// Collection metadata only — never requests or folders, which have their own
// endpoints; accepting them here would reopen the whole-document overwrite.
app.patch('/api/collections/:id', asyncH(async (req, res) => {
  const { name, auth, baseUrl } = req.body || {};
  const c = await collections.update(req.params.id, (cur) => ({
    ...cur,
    ...(name !== undefined ? { name } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  }));
  updated(res)(c);
}));

// Upsert one request, wholesale. Used by auto-save and by creating a request.
app.put('/api/collections/:id/requests/:rid', asyncH(async (req, res) => {
  const record = { ...(req.body || {}), id: req.params.rid } as SavedRequest;
  const c = await collections.update(req.params.id, (cur) => {
    const requests = (cur.requests || []).slice();
    const idx = requests.findIndex((r) => r.id === record.id);
    if (idx >= 0) requests[idx] = record;
    else requests.push(record);
    return { ...cur, requests };
  });
  updated(res)(c);
}));

// Merge fields into one request, leaving the rest of it alone.
app.patch('/api/collections/:id/requests/:rid', asyncH(async (req, res) => {
  const patch = req.body || {};
  const c = await collections.update(req.params.id, (cur) => {
    const requests = (cur.requests || []).slice();
    const idx = requests.findIndex((r) => r.id === req.params.rid);
    if (idx < 0) return null;
    requests[idx] = { ...requests[idx]!, ...patch, id: requests[idx]!.id };
    return { ...cur, requests };
  });
  updated(res)(c);
}));

app.delete('/api/collections/:id/requests/:rid', asyncH(async (req, res) => {
  const c = await collections.update(req.params.id, (cur) => ({
    ...cur,
    requests: (cur.requests || []).filter((r) => r.id !== req.params.rid),
  }));
  updated(res)(c);
}));

app.post('/api/collections/:id/folders', asyncH(async (req, res) => {
  const { id, name, parentId } = req.body || {};
  const folder: Folder = { id: id || newId(), name: name || 'New Folder', parentId: parentId || null };
  const c = await collections.update(req.params.id, (cur) => ({
    ...cur,
    folders: [...(cur.folders || []), folder],
  }));
  updated(res)(c);
}));

app.patch('/api/collections/:id/folders/:fid', asyncH(async (req, res) => {
  const { name, parentId } = req.body || {};
  const c = await collections.update(req.params.id, (cur) => {
    const folders = (cur.folders || []).slice();
    const idx = folders.findIndex((f) => f.id === req.params.fid);
    if (idx < 0) return null;
    folders[idx] = {
      ...folders[idx]!,
      ...(name !== undefined ? { name } : {}),
      ...(parentId !== undefined ? { parentId: parentId || null } : {}),
    };
    return { ...cur, folders };
  });
  updated(res)(c);
}));

// Deleting a folder takes its subtree and the requests inside with it — worked
// out here so the whole cascade lands as one write.
app.delete('/api/collections/:id/folders/:fid', asyncH(async (req, res) => {
  const c = await collections.update(req.params.id, (cur) => {
    const doomed = withDescendants(cur.folders || [], req.params.fid);
    return {
      ...cur,
      folders: (cur.folders || []).filter((f) => !doomed.includes(f.id)),
      requests: (cur.requests || []).filter((r) => !doomed.includes(r.folderId as string)),
    };
  });
  updated(res)(c);
}));

// ---- Environments ----
app.get('/api/environments', asyncH(async (req, res) => res.json(await environments.list())));
app.post('/api/environments', asyncH(async (req, res) => res.json(await environments.save(req.body || {}))));
app.put('/api/environments/:id', asyncH(async (req, res) =>
  res.json(await environments.save({ ...(req.body as EnvironmentInput), id: req.params.id }))));
app.delete('/api/environments/:id', asyncH(async (req, res) => {
  const ok = await environments.remove(req.params.id);
  res.json({ ok });
}));

// ---- Import (Postman collection or environment export) ----
app.post('/api/import/postman', asyncH(async (req, res) => {
  const data = req.body || {};
  if (Array.isArray(data.values) && !data.item) {
    const env = await environments.save(convertPostmanEnvironment(data));
    return res.json({ type: 'environment', name: env.name, variables: Object.keys(env.variables).length });
  }
  if (!Array.isArray(data.item)) {
    return res.status(400).json({ error: 'Not a Postman collection or environment export (v2.x JSON expected)' });
  }
  const converted = convertPostmanCollection(data);
  const names: string[] = [];
  let requestCount = 0;
  let folderCount = 0;
  // The host lifted out of the requests. Worth reporting: an export usually
  // names it with a {{variable}} it never defines, and until that variable
  // exists in an environment nothing in the collection will resolve.
  let baseUrl = '';
  for (const c of converted) {
    const rec = await collections.save(c);
    names.push(rec.name);
    requestCount += rec.requests.length;
    folderCount += (rec.folders || []).length;
    if (!baseUrl && rec.baseUrl) baseUrl = rec.baseUrl;
  }
  res.json({
    type: 'collection', collections: names, requests: requestCount,
    folders: folderCount, baseUrl,
  });
}));

// ---- Has anything changed? ----
// The browser is not the only editor here: MCP writes land through this same
// process while a tab sits open on the old data. This answers "is what you
// loaded still current" without reading a single file, so a tab can ask often.
app.get('/api/rev', (req, res) => res.json(revision));

// ---- Export / import everything (moving this workspace to another machine) ----
// One file carries collections, environments, flows and the saved base URLs in
// their stored shape — no conversion, so nothing is lost on the way out or in.
const WORKSPACE_FORMAT = 'api-test/workspace';

// The sidebar's two halves, plus the context both of them resolve against.
// Sections, not stores, because the things that have to travel together do:
// a flow filed under a folder the other machine never got is filed nowhere,
// and an environment without its base URLs resolves to the built-in default.
const SECTIONS = ['tests', 'flows', 'environments'];

class BadInclude extends Error {}

// No `include` means everything — an older client, MCP, or a plain
// `curl /api/export` all still get the whole workspace.
function parseInclude(param: unknown): string[] {
  if (param === undefined || param === '') return SECTIONS.slice();
  const wanted = [...new Set(String(param).split(',').map((s) => s.trim()).filter(Boolean))];
  const unknown = wanted.filter((s) => !SECTIONS.includes(s));
  if (unknown.length) throw new BadInclude(`Unknown export section(s): ${unknown.join(', ')}`);
  if (!wanted.length) throw new BadInclude('Nothing selected to transfer');
  return wanted;
}

// What an export file carries. Every section is optional: `contents` says which
// ones were actually asked for.
interface WorkspaceFile {
  format: string;
  version: number;
  exportedAt: string;
  contents: string[];
  collections?: Collection[];
  flows?: Flow[];
  flowFolders?: Folder[];
  environments?: Environment[];
  baseUrls?: string[];
}

app.get('/api/export', asyncH(async (req, res) => {
  let include: string[];
  try {
    include = parseInclude(req.query.include);
  } catch (err) {
    if (!(err instanceof BadInclude)) throw err;
    return res.status(400).json({ error: err.message, hint: `Sections: ${SECTIONS.join(', ')}` });
  }

  // What is in the file, stated rather than inferred: the import side shows it
  // before anything is written, and an empty section reads as "exported, had
  // none" instead of "not exported".
  const out: WorkspaceFile = {
    format: WORKSPACE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    contents: include,
  };
  if (include.includes('tests')) out.collections = await collections.list();
  if (include.includes('flows')) {
    out.flows = await flows.list();
    // Without these the flows land on the other machine filed under folders
    // that do not exist there.
    out.flowFolders = await flowFolders.list();
  }
  if (include.includes('environments')) {
    out.environments = await environments.list();
    out.baseUrls = await baseUrls.list();
  }
  return res.json(out);
}));

// A store that can take a record back in, whatever kind it holds.
interface Upsertable<T> {
  save(item: T): Promise<{ id: string }>;
}

// Restoring is an upsert on the stored ids, not an append: importing the same
// file twice updates what is already here instead of leaving two of everything,
// which is what makes this usable as a sync rather than a one-shot restore. Ids
// also keep a flow's steps pointing at the right requests.
//
// `include` narrows it further: only sections both asked for AND present in the
// file are written, so a whole-workspace file can be imported for its flows
// alone without its collections landing on top of the ones here.
app.post('/api/import/workspace', asyncH(async (req, res) => {
  const data = req.body || {};
  if (data.format !== WORKSPACE_FORMAT) {
    return res.status(400).json({
      error: 'Not an api-test export file',
      hint: 'Export from the other machine with the export button, or use a Postman v2.x export instead.',
    });
  }
  let include: string[];
  try {
    include = parseInclude(req.query.include);
  } catch (err) {
    if (!(err instanceof BadInclude)) throw err;
    return res.status(400).json({ error: err.message, hint: `Sections: ${SECTIONS.join(', ')}` });
  }
  const wants = (section: string, list: unknown) =>
    include.includes(section) && Array.isArray(list);

  async function upsert<T extends { id?: string }>(
    store: Upsertable<T>,
    items: T[],
    existingIds: Set<string>,
  ): Promise<{ added: number; updated: number }> {
    const counts = { added: 0, updated: 0 };
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      if (item.id && existingIds.has(item.id)) counts.updated += 1;
      else counts.added += 1;
      await store.save(item);
    }
    return counts;
  }

  const idsOf = (list: Array<{ id: string }>) => new Set(list.map((x) => x.id));
  const [colIds, envIds, flowIds, currentUrls] = await Promise.all([
    collections.list().then(idsOf),
    environments.list().then(idsOf),
    flows.list().then(idsOf),
    baseUrls.list(),
  ]);

  // A section left out is left alone: no key in the result either, so the
  // caller reports what it actually did rather than "0 added, 0 updated" for
  // something it never touched.
  const result: Record<string, unknown> & { applied: string[] } = { applied: [] };
  if (wants('tests', data.collections)) {
    result.collections = await upsert<CollectionInput>(collections, data.collections, colIds);
    result.applied.push('tests');
  }
  if (wants('environments', data.environments)) {
    result.environments = await upsert<EnvironmentInput>(environments, data.environments, envIds);
    result.applied.push('environments');
  }
  if (wants('flows', data.flows)) {
    result.flows = await upsert<FlowInput>(flows, data.flows, flowIds);
    result.applied.push('flows');
  }

  // Flow folders are one list, not a document each: upsert by id so a second
  // import updates the tree instead of duplicating it, and folders this machine
  // has that the file doesn't are left where they are.
  const incomingFolders: Folder[] = (include.includes('flows') && Array.isArray(data.flowFolders)
    ? data.flowFolders : [])
    .filter((f: Folder | null) => f && typeof f === 'object' && f.id);
  if (incomingFolders.length) {
    result.flowFolders = await flowFolders.update((cur) => {
      const next = cur.slice();
      for (const f of incomingFolders) {
        const folder: Folder = { id: f.id, name: f.name || 'Folder', parentId: f.parentId || null };
        const idx = next.findIndex((x) => x.id === folder.id);
        if (idx >= 0) next[idx] = folder;
        else next.push(folder);
      }
      return next;
    }).then((list) => list.length);
  }

  // Base URLs are a pick-list, so the two machines' lists are merged rather
  // than one replacing the other. They travel with the environments: on their
  // own they are a list of hosts nothing points at.
  if (wants('environments', data.baseUrls)) {
    const merged = [...currentUrls];
    for (const u of data.baseUrls) {
      if (typeof u === 'string' && u.trim() && !merged.includes(u.trim())) merged.push(u.trim());
    }
    await baseUrls.save(merged);
    result.baseUrls = merged.length - currentUrls.length;
  }

  // Uploaded files live outside the JSON (they are bytes), so a form-data file
  // field arrives pointing at an upload this machine does not have. Say how
  // many, rather than letting it surface later as a failed send.
  if (result.collections) {
    let fileFields = 0;
    for (const c of data.collections as Collection[]) {
      for (const r of (c && c.requests) || []) {
        const form = 'form' in r ? r.form : undefined;
        for (const f of form || []) if (f && f.type === 'file' && f.fileId) fileFields += 1;
      }
    }
    result.fileFields = fileFields;
  }

  // Flows imported without their tests: a step naming a saved request has
  // nothing to run. Answer it from the store as it now stands rather than from
  // the file, so a flows-only import onto a machine that already has those
  // collections correctly reports nothing missing.
  if (result.flows) {
    const here = await collections.list();
    const known = new Set<string>();
    for (const c of here) for (const r of c.requests || []) known.add(`${c.id}/${r.id}`);
    const danglingFlows = new Set<string>();
    let danglingSteps = 0;
    for (const f of data.flows as Flow[]) {
      for (const s of (f && f.steps) || []) {
        if (!s || !s.requestId || !s.collectionId) continue; // inline / shell steps carry their own
        if (known.has(`${s.collectionId}/${s.requestId}`)) continue;
        danglingSteps += 1;
        danglingFlows.add(f.name || f.id);
      }
    }
    if (danglingSteps) {
      result.missingRequests = { steps: danglingSteps, flows: [...danglingFlows] };
    }
  }

  return res.json(result);
}));

// An unknown /api path stops here. Without this it falls through to the SPA
// catch-all below and comes back as index.html with a 200, so the caller fails
// on JSON.parse instead of being told the endpoint does not exist.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` });
});

// Failures raised before a route ever runs — a body over the limit, malformed
// JSON — otherwise come back as express's HTML error page, which the client
// reads as a broken response rather than the reason it was rejected.
const apiErrors: ErrorRequestHandler = (err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
};
app.use('/api', apiErrors);

// ---- Serve built frontend (production) ----
const clientDist = path.join(import.meta.dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

ensureDirs().then(async () => {
  // Before anything can be served: a flow still carrying the old `group` label
  // would otherwise show up filed nowhere.
  try {
    const moved = await migrateFlowGroups();
    if (moved.flows) {
      console.log(`filed ${moved.flows} flow(s) into ${moved.folders} folder(s) from their old group`);
    }
  } catch (err) {
    console.error('flow group migration failed:', (err as Error).message);
  }

  app.listen(PORT as number, HOST, () => {
    console.log(`api-test server listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`data directory: ${DATA_DIR}`);
  });
  // Uploads outlive the requests that referenced them; clear the strays at
  // startup so data/uploads doesn't grow without bound.
  files.sweepOrphans()
    .then((n) => { if (n) console.log(`removed ${n} orphaned upload(s)`); })
    .catch((err) => console.error('upload sweep failed:', err.message));
});
