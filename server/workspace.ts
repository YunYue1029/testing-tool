// Moving a whole workspace between machines: one file carrying collections,
// environments, flows and the saved base URLs in their stored shape.
import type { Request, Response } from 'express';
import { collections, environments, flows, flowFolders, baseUrls } from './store.ts';
import type {
  Collection, CollectionInput, Environment, EnvironmentInput, Flow, FlowInput, Folder,
} from './types.ts';

// ---- Export / import everything (moving this workspace to another machine) ----
// One file carries collections, environments, flows and the saved base URLs in
// their stored shape — no conversion, so nothing is lost on the way out or in.
const WORKSPACE_FORMAT = 'testing-tool/workspace';
// What the tool wrote under its old name. Files already exported carry it, and
// they are exactly the workspaces someone is moving between machines, so import
// keeps accepting it — only export stops producing it.
const LEGACY_WORKSPACE_FORMAT = 'api-test/workspace';

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

async function exportWorkspace(req: Request, res: Response): Promise<unknown> {
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
}

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
async function importWorkspace(req: Request, res: Response): Promise<unknown> {
  const data = req.body || {};
  if (data.format !== WORKSPACE_FORMAT && data.format !== LEGACY_WORKSPACE_FORMAT) {
    return res.status(400).json({
      error: 'Not a testing-tool export file',
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
}

export { exportWorkspace, importWorkspace };

