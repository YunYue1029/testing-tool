// Simple JSON-file backed storage.
// Each collection is one JSON file under data/collections/<id>.json
// Each environment is one JSON file under data/environments/<id>.json
import fs from 'fs/promises';
import path from 'path';
import type {
  Auth, AuthType, Collection, CollectionInput, Environment, EnvironmentInput,
  FileMeta, Flow, FlowInput, Folder, InlineBodyType, InlineRequest, Row,
  SavedRequest, Step, StepInput, StoredFile,
} from './types.ts';
import { newId } from './ids.ts';

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(import.meta.dirname, '..', 'data');
const COLLECTIONS_DIR = path.join(DATA_DIR, 'collections');
const ENVIRONMENTS_DIR = path.join(DATA_DIR, 'environments');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const FLOWS_DIR = path.join(DATA_DIR, 'flows');
const BASE_URLS_FILE = path.join(DATA_DIR, 'base_urls.json');
// Flow folders live in one file rather than inside the flows: a folder outlives
// the flows in it (an empty one is still a place to put the next flow), and the
// tree has to be readable without opening every flow.
const FLOW_FOLDERS_FILE = path.join(DATA_DIR, 'flow_folders.json');

// fs and child_process errors arrive as unknown; this is the one property
// every branch below actually reads off them.
function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

// Ids come from client JSON and end up in file paths. Ours are base36 (ids.ts);
// the tests and older imports also carry hyphens and underscores. Anything
// else — a dot, a slash — could name a file outside the directory it was
// meant for, so it is treated as no record at all rather than joined onto a path.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id);
}

// A caller-supplied id that cannot name a file. Carries the status the API
// answers with, the way express's own body-parser errors do, so index.ts can
// treat the two alike.
class InvalidId extends Error {
  status = 400;

  constructor(id: string) {
    super(`"${id}" is not a valid id`);
  }
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(COLLECTIONS_DIR, { recursive: true });
  await fs.mkdir(ENVIRONMENTS_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(FLOWS_DIR, { recursive: true });
}

// What comes back out of a JSON file is whatever was written into it; the
// caller names the shape it expects, exactly as it did when this was untyped.
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if (errCode(err) === 'ENOENT') return fallback;
    throw err;
  }
}

// How many times anything here has been written, plus when this process
// started (the counter restarts with it). A browser polls the pair to notice
// edits it did not make — MCP writes reach the disk through this same process,
// so counting in memory is enough and costs no file reads to answer.
const revision = { startedAt: Date.now(), rev: 0 };
function bumpRev(): void { revision.rev += 1; }

// Atomic write: write to a temp file in the same directory, then rename over
// the target (rename within one filesystem is atomic), so readers never see a
// half-written file. The temp name doesn't end in .json, so listFrom skips it.
async function writeJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    await fs.rename(tmp, file);
    bumpRev();
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

// Per-file write serialization: chain each critical section onto the previous
// one for the same key, so concurrent writes to one file run in order instead
// of interleaving. (This guards the file level only — API-level read-modify-
// write of whole collections can still lose updates between GET and PUT.)
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  locks.set(key, tail);
  return run;
}

async function listFrom<T>(dir: string): Promise<T[]> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return [];
    throw err;
  }
  const names = files.filter((f) => f.endsWith('.json'));
  const items: Array<T | null> = new Array(names.length).fill(null);
  await Promise.all(names.map(async (f, i) => {
    const file = path.join(dir, f);
    try {
      items[i] = await readJson<T | null>(file, null);
    } catch (err) {
      // One file left half-edited by hand must not take every list endpoint
      // down with it; say which one and carry on without it.
      if (!(err instanceof SyntaxError)) throw err;
      console.error(`${file} is not valid JSON, skipping it: ${err.message}`);
    }
  }));
  return items.filter((x): x is T => !!x);
}

// A directory of <id>.json records, which is what each of the three stores
// below is. Reading, listing and removing are the same for all of them; what
// differs is the shape a save normalises to, which each store keeps for itself.
function jsonDir<T>(dir: string, lockPrefix: string) {
  const file = (id: string): string => path.join(dir, `${id}.json`);
  const lock = <R>(id: string, fn: () => Promise<R>): Promise<R> => withLock(`${lockPrefix}:${id}`, fn);
  return {
    file,
    lock,
    // The id a save writes under: the caller's, once it is known to name a
    // file in this directory and nothing beyond it, else a fresh one.
    idFor(supplied: string | undefined): string {
      if (!supplied) return newId();
      if (!isSafeId(supplied)) throw new InvalidId(supplied);
      return supplied;
    },
    list: (): Promise<T[]> => listFrom<T>(dir),
    get: (id: string): Promise<T | null> =>
      (isSafeId(id) ? readJson<T | null>(file(id), null) : Promise.resolve(null)),
    remove(id: string): Promise<boolean> {
      if (!isSafeId(id)) return Promise.resolve(false);
      return lock(id, async () => {
        try {
          await fs.unlink(file(id));
          bumpRev();
          return true;
        } catch (err) {
          if (errCode(err) === 'ENOENT') return false;
          throw err;
        }
      });
    },
  };
}

// The stored shape of a collection, from whatever a caller supplied.
function shapeCollection(collection: CollectionInput, id: string): Collection {
  return {
    id,
    name: collection.name || 'Untitled Collection',
    // Default auth applied to requests that lack their own — a structured
    // object ({ type, token, ... }) or a legacy raw string. '' = off.
    auth: collection.auth != null ? collection.auth : '',
    // Per-collection {{base_url}} override (may contain {{vars}}). '' = use
    // the environment's base_url or the built-in default.
    baseUrl: typeof collection.baseUrl === 'string' ? collection.baseUrl : '',
    // Folders form a tree via parentId (null = directly under the collection).
    folders: Array.isArray(collection.folders) ? collection.folders : [],
    // Requests stay a flat list; each carries an optional folderId.
    requests: Array.isArray(collection.requests) ? collection.requests : [],
    updatedAt: new Date().toISOString(),
  };
}

// `mutate` gets the current record and returns the new one, or null to abort.
type CollectionMutator =
  (cur: Collection) => CollectionInput | null | Promise<CollectionInput | null>;

// ---- Collections ----
const collectionFiles = jsonDir<Collection>(COLLECTIONS_DIR, 'col');
const collections = {
  list: collectionFiles.list,
  get: collectionFiles.get,
  save(collection: CollectionInput): Promise<Collection> {
    const id = collectionFiles.idFor(collection.id);
    const record = shapeCollection(collection, id);
    return collectionFiles.lock(id, async () => {
      await writeJson(collectionFiles.file(id), record);
      return record;
    });
  },

  // Read, modify and write as one locked step, so editing one request can't
  // clobber a concurrent edit to another. `save` cannot offer this: its caller
  // read the document seconds earlier and hands back a whole replacement, with
  // no way for the server to tell which parts were meant to change. Every
  // partial edit must come through here.
  // `mutate` gets the current record and returns the new one, or null to
  // abort (e.g. the target request no longer exists).
  update(id: string, mutate: CollectionMutator): Promise<Collection | null> {
    if (!isSafeId(id)) return Promise.resolve(null);
    return collectionFiles.lock(id, async () => {
      const file = collectionFiles.file(id);
      const current = await readJson<Collection | null>(file, null);
      if (!current) return null;
      const next = await mutate(current);
      if (!next) return null;
      const record = shapeCollection(next, id);
      await writeJson(file, record);
      return record;
    });
  },
  remove: collectionFiles.remove,
};

// ---- Environments ----
const environmentFiles = jsonDir<Environment>(ENVIRONMENTS_DIR, 'env');
const environments = {
  list: environmentFiles.list,
  get: environmentFiles.get,
  async save(env: EnvironmentInput): Promise<Environment> {
    const id = environmentFiles.idFor(env.id);
    const file = environmentFiles.file(id);
    const record = await environmentFiles.lock(id, async () => {
      // The editor saves name and variables as they are typed and says
      // nothing about being the default, so a save that leaves the flag out
      // keeps what is stored rather than clearing it.
      const stored = env.isDefault === undefined ? await readJson<Environment | null>(file, null) : null;
      const rec: Environment = {
        id,
        name: env.name || 'Untitled Environment',
        variables: env.variables && typeof env.variables === 'object' ? env.variables : {},
        // Keys listed here keep their value but are excluded from substitution.
        disabled: Array.isArray(env.disabled) ? env.disabled : [],
        ...((env.isDefault === undefined ? !!(stored && stored.isDefault) : env.isDefault === true)
          ? { isDefault: true } : {}),
        updatedAt: new Date().toISOString(),
      };
      await writeJson(file, rec);
      return rec;
    });
    // One default at a time: marking this one unmarks whichever was.
    if (record.isDefault) {
      for (const other of await environments.list()) {
        if (other.id === id || !other.isDefault) continue;
        await environmentFiles.lock(other.id, async () => {
          const f = environmentFiles.file(other.id);
          const cur = await readJson<Environment | null>(f, null);
          if (!cur || !cur.isDefault) return;
          const { isDefault: _was, ...rest } = cur;
          await writeJson(f, { ...rest, updatedAt: new Date().toISOString() });
        });
      }
    }
    return record;
  },
  // Add each key, empty, to every environment that lacks it — a new
  // collection's url variable, there to fill in whichever one you switch to.
  // A key an environment already has keeps its value.
  async declare(keys: string[]): Promise<void> {
    for (const { id } of await environments.list()) {
      await environmentFiles.lock(id, async () => {
        const file = environmentFiles.file(id);
        const cur = await readJson<Environment | null>(file, null);
        if (!cur) return;
        const vars = cur.variables || {};
        const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(vars, k));
        if (!missing.length) return;
        await writeJson(file, {
          ...cur,
          variables: { ...vars, ...Object.fromEntries(missing.map((k) => [k, ''])) },
          updatedAt: new Date().toISOString(),
        });
      });
    }
  },
  remove: environmentFiles.remove,
};

// ---- Flows ----
// An ordered list of steps, each pointing at a saved request, run together to
// exercise a whole feature (create -> read -> update -> delete). Unlike a
// collection, a flow is one editing unit — nobody edits step 3 while someone
// else edits step 7 — so whole-document writes are fine here, the way they are
// for environments.
// A request typed straight into a step, for an endpoint nobody wants filed in a
// collection — a one-off probe, or a call that only makes sense inside this
// flow. Deliberately a smaller shape than a saved request: no body variants (a
// step has one body), no form-data (its file uploads outlive the flow), no
// script (the step's own script already runs after the response).
const STEP_MODES = ['saved', 'inline', 'shell'] as const;
const INLINE_BODY_TYPES = ['none', 'json', 'text'] as const;
const AUTH_TYPES = ['inherit', 'none', 'bearer', 'apikey'] as const;

function isStepMode(v: unknown): v is Step['mode'] {
  return typeof v === 'string' && (STEP_MODES as readonly string[]).includes(v);
}
function isInlineBodyType(v: unknown): v is InlineBodyType {
  return typeof v === 'string' && (INLINE_BODY_TYPES as readonly string[]).includes(v);
}
function isAuthType(v: unknown): v is AuthType {
  return typeof v === 'string' && (AUTH_TYPES as readonly string[]).includes(v);
}

// What the step sends for authentication, keeping only the fields its type
// uses — a stored auth still carrying the token of a type switched away from
// reads as if that token were live.
function inlineAuth(a: Partial<Record<string, unknown>> | undefined): Auth {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const type: AuthType = a && isAuthType(a.type) ? a.type : 'inherit';
  if (type === 'bearer') {
    // A prefix left out means "Bearer" and an empty one means send the token
    // bare (see BearerAuth), so the absence has to survive the save.
    return {
      type,
      token: str(a?.token),
      ...(typeof a?.prefix === 'string' ? { prefix: a.prefix } : {}),
    };
  }
  if (type === 'apikey') return { type, header: str(a?.header), value: str(a?.value) };
  return { type };
}

function inlineRequest(r: Partial<InlineRequest> | undefined): InlineRequest | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const rows = (list: Row[] | undefined): Row[] => (Array.isArray(list) ? list : []);
  return {
    method: typeof r.method === 'string' && r.method.trim() ? r.method.toUpperCase() : 'GET',
    url: typeof r.url === 'string' ? r.url : '',
    headers: rows(r.headers),
    params: rows(r.params),
    bodyType: isInlineBodyType(r.bodyType) ? r.bodyType : 'none',
    body: typeof r.body === 'string' ? r.body : '',
    auth: inlineAuth(r.auth as Partial<Record<string, unknown>> | undefined),
  };
}

const flowFiles = jsonDir<Flow>(FLOWS_DIR, 'flow');
const flows = {
  list: flowFiles.list,
  get: flowFiles.get,
  save(flow: FlowInput): Promise<Flow> {
    const id = flowFiles.idFor(flow.id);
    const record: Flow = {
      id,
      name: flow.name || 'Untitled Flow',
      // What the flow is for, in the words of whoever wrote it. A name has room
      // for "timezone" and not for which of the four timezone flows this is —
      // and the one reading it months later is the one who needs telling.
      description: typeof flow.description === 'string' ? flow.description : '',
      // Which folder of the flow tree it sits in (null = the root). Unlike a
      // collection's folders, these names carry no URL meaning — where a flow
      // is filed says nothing about where its requests go.
      folderId: flow.folderId || null,
      // Default environment for a run; the runner's own argument wins.
      environmentId: flow.environmentId || null,
      // The flow's own variables, as rows so an unchecked one keeps its value.
      vars: (Array.isArray(flow.vars) ? flow.vars : [])
        .filter((r) => r && typeof r.key === 'string')
        .map((r): Row => {
          const byEnv = r.byEnv && typeof r.byEnv === 'object'
            ? Object.fromEntries(Object.entries(r.byEnv)
              .filter(([k, v]) => k && typeof v === 'string' && v !== ''))
            : {};
          return {
            key: r.key,
            value: typeof r.value === 'string' ? r.value : '',
            ...(r.enabled === false ? { enabled: false } : {}),
            ...(Object.keys(byEnv).length ? { byEnv } : {}),
          };
        }),
      // What the flow's shell steps run in. One session by default — the same
      // shell for every command in the run, so a cd or an export reaches the
      // steps after it, which is what makes a sequence of commands worth
      // splitting into steps at all. `cwd` is where that shell starts;
      // session:false goes back to a fresh shell per command, for a flow whose
      // commands should not be able to affect one another.
      shell: {
        session: flow.shell ? flow.shell.session !== false : true,
        cwd: typeof flow.shell?.cwd === 'string' ? flow.shell.cwd : '',
      },
      steps: (Array.isArray(flow.steps) ? flow.steps : []).map((s: StepInput): Step => ({
        id: s.id || newId(),
        name: s.name || '',
        // Which of the three the step runs: a saved request, the one typed into
        // `request` below, or the shell command in `command`. All are kept
        // whichever is active, so switching between them doesn't discard the
        // other's work.
        mode: isStepMode(s.mode) ? s.mode : 'saved',
        // In inline mode a collection is optional and contributes only its
        // base_url and default auth — there is no folder, so {{dy_url}} is
        // just {{base_url}}.
        collectionId: s.collectionId || null,
        requestId: s.requestId || null,
        request: inlineRequest(s.request),
        // Shell mode: the command line, and where and how long it may run.
        // Kept as typed — {{vars}} are resolved at run time, not here.
        command: typeof s.command === 'string' ? s.command : '',
        cwd: typeof s.cwd === 'string' ? s.cwd : '',
        timeout: Number(s.timeout) > 0 ? Number(s.timeout) : undefined,
        enabled: s.enabled !== false,
        // Teardown: runs even after an earlier step failed, so a flow that
        // creates rows still deletes them.
        always: s.always === true,
        when: (Array.isArray(s.when) ? s.when : [])
          .filter((c) => c && typeof c.var === 'string' && c.var.trim())
          .map((c) => ({
            var: c.var.trim(),
            op: c.op || 'eq',
            value: c.value == null ? '' : String(c.value),
          })),
        overrides: s.overrides && typeof s.overrides === 'object' ? s.overrides : undefined,
        extract: Array.isArray(s.extract) ? s.extract : [],
        assert: Array.isArray(s.assert) ? s.assert : [],
        script: typeof s.script === 'string' ? s.script : '',
      })),
      updatedAt: new Date().toISOString(),
    };
    return flowFiles.lock(id, async () => {
      await writeJson(flowFiles.file(id), record);
      return record;
    });
  },
  remove: flowFiles.remove,
};

// ---- Flow folders ----
// The tree flows are filed under: a flat list of {id, name, parentId}, the same
// shape a collection uses for its own folders, so folderChain/folderPath work on
// either without knowing which it was handed.
const flowFolders = {
  list: (): Promise<Folder[]> => readJson<Folder[]>(FLOW_FOLDERS_FILE, []),
  // Read-modify-write under one lock. `fn` returns the next list, or null to
  // leave the file untouched.
  update(fn: (cur: Folder[]) => Folder[] | null): Promise<Folder[]> {
    return withLock('flow-folders', async () => {
      const cur = await readJson<Folder[]>(FLOW_FOLDERS_FILE, []);
      const next = fn(cur);
      if (!next) return cur;
      await writeJson(FLOW_FOLDERS_FILE, next);
      return next;
    });
  },
};

// A flow as it may still sit on disk, before the group migration has run.
type LegacyFlow = Flow & { group?: string };

// Flows used to carry a plain `group` label. Turn each distinct one into a
// top-level folder, once, on the first start after the upgrade: doing it here
// rather than on every read means nothing downstream has to know both shapes.
// Idempotent — a flow already filed, or one that never had a group, is left
// alone, so this is a no-op from the second start onwards.
async function migrateFlowGroups(): Promise<{ folders: number; flows: number }> {
  const flowList = await flows.list() as LegacyFlow[];
  const stale = flowList.filter(
    (f) => typeof f.group === 'string' && f.group.trim() && !f.folderId,
  );
  if (!stale.length) return { folders: 0, flows: 0 };

  const existing = await flowFolders.list();
  const byName = new Map<string, Folder>(existing.map((f) => [f.name, f]));
  const added: Folder[] = [];
  for (const flow of stale) {
    const name = flow.group!.trim();
    if (byName.has(name)) continue;
    const folder: Folder = { id: newId(), name, parentId: null };
    byName.set(name, folder);
    added.push(folder);
  }
  if (added.length) await flowFolders.update((cur) => [...cur, ...added]);

  for (const flow of stale) {
    // save() drops `group` on its own — it is no longer part of the record.
    await flows.save({ ...flow, folderId: byName.get(flow.group!.trim())!.id });
  }
  return { folders: added.length, flows: stale.length };
}

// ---- Saved base URLs ----
// A plain pick-list of hosts to point a collection at. It is deliberately
// independent of the collections: a URL stays offered after the collection that
// used it moves elsewhere, which is the whole point of saving it.
const baseUrls = {
  list: (): Promise<string[]> => readJson<string[]>(BASE_URLS_FILE, []),
  save(list: unknown): Promise<string[]> {
    const clean: string[] = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const url = typeof raw === 'string' ? raw.trim() : '';
      if (url && !clean.includes(url)) clean.push(url);
    }
    return withLock('base-urls', async () => {
      await writeJson(BASE_URLS_FILE, clean);
      return clean;
    });
  },
};

// ---- Uploaded files (multipart/form-data bodies) ----
// The bytes live in data/uploads/<id>, the metadata beside them in <id>.json.
// A saved request only stores the id, so it can be re-sent later — the browser
// cannot hand back a File it picked in an earlier session, and a path on the
// browser's machine (what Postman stores) is not the server's to read.
const files = {
  async save(
    buffer: Buffer,
    { name, type }: { name?: string; type?: string } = {},
  ): Promise<FileMeta> {
    const id = newId();
    const meta: FileMeta = {
      id,
      name: name || 'file',
      type: type || 'application/octet-stream',
      size: buffer.length,
      uploadedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(UPLOADS_DIR, id), buffer);
    await writeJson(path.join(UPLOADS_DIR, `${id}.json`), meta);
    return meta;
  },
  // Delete uploads no request references any more. Only files older than
  // `minAgeMs` are considered: one just uploaded is not in a saved request yet
  // (the user is still filling the row in), and sweeping it would break the
  // request being built.
  async sweepOrphans(minAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const used = new Set<string>();
    for (const c of await collections.list()) {
      for (const r of c.requests || []) {
        const form = 'form' in r ? r.form : undefined;
        for (const row of form || []) {
          // Keyed off the field rather than the row type, exactly as before: a
          // text row that somehow carries a fileId still protects that upload.
          if (row && 'fileId' in row && row.fileId) used.add(row.fileId);
        }
      }
    }
    let names: string[];
    try {
      names = await fs.readdir(UPLOADS_DIR);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return 0;
      throw err;
    }
    const cutoff = Date.now() - minAgeMs;
    let removed = 0;
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : name;
      if (used.has(id)) continue;
      const file = path.join(UPLOADS_DIR, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.mtimeMs > cutoff) continue;
      await fs.unlink(file).catch(() => {});
      removed += 1;
    }
    return removed;
  },
  // Returns { meta, buffer } or null when the id is unknown / no longer on disk.
  async read(id: string | undefined): Promise<StoredFile | null> {
    // ids come from client JSON, so reject anything that isn't one of ours
    // before it reaches path.join and escapes the uploads directory.
    if (!isSafeId(id)) return null;
    const meta = await readJson<FileMeta | null>(path.join(UPLOADS_DIR, `${id}.json`), null);
    if (!meta) return null;
    try {
      return { meta, buffer: await fs.readFile(path.join(UPLOADS_DIR, id)) };
    } catch (err) {
      if (errCode(err) === 'ENOENT') return null;
      throw err;
    }
  },
};

export {
  ensureDirs, collections, environments, flows, flowFolders, migrateFlowGroups,
  baseUrls, files, revision, isSafeId, InvalidId, DATA_DIR,
};
