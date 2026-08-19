import React, { useEffect, useState, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import RequestPanel from './components/RequestPanel';
import ResponsePanel from './components/ResponsePanel';
import EnvironmentBar from './components/EnvironmentBar';
import SaveRequestModal from './components/SaveRequestModal';
import CollectionSettingsModal from './components/CollectionSettingsModal';
import TransferModal from './components/TransferModal';
import FlowPanel from './components/FlowPanel';
import { api } from './api';
// What remains here is preview only — composing the URL shown under the bar,
// highlighting {{vars}}, describing auth. Building the request that actually
// goes out moved to the server (see server/runner.js).
import ShellTestPanel from './components/ShellTestPanel';
import {
  newRequest, newShellTest, isShellTest, normalizeRequest, substitute,
  uid, folderPath, folderWithDescendants, composeUrl, dyUrl, DEFAULT_BASE_URL,
  applyCollectionBaseUrl, describeAuth, requestVars,
} from './util';
import type {
  Collection, Environment, Flow, FlowReport, Folder, RunResponse, SavedRequest,
  StepReport,
} from './types.ts';
import type { ScriptReport } from '../../server/types.ts';

// The export/import dialog's state: which direction, what each section holds,
// and — importing — the file waiting to be written.
interface TransferState {
  mode: 'export' | 'import';
  counts: Record<string, number>;
  exportedAt?: string;
  data?: Record<string, unknown>;
}

// A flow report as the panel holds it. Two things the server never sends: the
// message from a run that failed before it started, and which single step a
// one-step run covered.
interface FlowRunReport extends Partial<FlowReport> {
  ok: boolean;
  durationMs: number;
  steps: StepReport[];
  vars: Record<string, string>;
  error?: string;
  oneStep?: string;
}

// What the save dialog answers with: where to file the request, and the name
// to file it under. `newCollectionName` is set instead of `collectionId` when
// the collection is being created on the spot.
interface SaveTarget {
  name: string;
  collectionId?: string | null;
  newCollectionName?: string;
  folderId?: string | null;
}

export default function App() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [savedBaseUrls, setSavedBaseUrls] = useState<string[]>([]);
  const [activeEnvId, setActiveEnvId] = useState(
    () => localStorage.getItem('activeEnvId') || null
  );

  const [request, setRequest] = useState<SavedRequest>(newRequest);
  const [collectionId, setCollectionId] = useState<string | null>(null); // where the open request lives
  const [response, setResponse] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [saveStatus, setSaveStatus] = useState(''); // '' | 'Saving…' | 'Saved' | 'Save failed'
  const [scriptResult, setScriptResult] = useState<ScriptReport | null>(null); // { saved } | { error }
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [settingsCol, setSettingsCol] = useState<Collection | null>(null); // collection being configured
  // Export or import waiting on which sections to move:
  // { mode: 'export'|'import', counts, exportedAt?, data? }
  const [transfer, setTransfer] = useState<TransferState | null>(null);

  // ---- Flows ----
  const [flows, setFlows] = useState<Flow[]>([]);
  const [flowFolders, setFlowFolders] = useState<Folder[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null); // the open flow, or null for the request view
  const [flowReport, setFlowReport] = useState<FlowRunReport | null>(null);
  const [flowRunning, setFlowRunning] = useState(false);
  const [runningStep, setRunningStep] = useState<string | null>(null); // step id being run on its own

  // Which revision of the server's data the screen was built from — the poll
  // further down compares against this to know whether it is out of date.
  const seenRev = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    // Read the counter before the lists, never after: a write landing in
    // between then leaves it looking stale and costs one needless refresh,
    // where the other order would record a revision we never actually loaded
    // and lose that change for good.
    const at = await api.getRev().catch(() => null);
    const [cols, envs, urls, fls, flowDirs] = await Promise.all([
      api.listCollections(), api.listEnvironments(), api.listBaseUrls(), api.listFlows(),
      api.listFlowFolders(),
    ]);
    if (at) seenRev.current = `${at.startedAt}:${at.rev}`;
    setCollections(cols);
    setEnvironments(envs);
    setSavedBaseUrls(urls);
    setFlows(fls);
    setFlowFolders(flowDirs);
    // Handed back for the poll below, which has to inspect what just arrived —
    // the state setters above have not landed yet at that point.
    return { collections: cols, flows: fls };
  }, []);

  useEffect(() => { refresh().catch((e) => setError((e as Error).message)); }, [refresh]);

  useEffect(() => {
    if (activeEnvId) localStorage.setItem('activeEnvId', activeEnvId);
    else localStorage.removeItem('activeEnvId');
  }, [activeEnvId]);

  const activeVars = () => {
    const env = environments.find((e) => e.id === activeEnvId);
    const vars = env ? { ...(env.variables || {}) } : {};
    if (env) for (const k of env.disabled || []) delete vars[k];
    // base_url is shared by everyone via a built-in default; an environment
    // may still override it by defining its own base_url.
    if (vars.base_url == null || vars.base_url === '') vars.base_url = DEFAULT_BASE_URL;
    return vars;
  };

  // Active-environment vars with the collection's own base_url (if any)
  // overriding {{base_url}}.
  const varsForCol = (col: Collection | null | undefined) => applyCollectionBaseUrl(activeVars(), col);

  // What the request panel previews with. Same order the server resolves in
  // (see runRequest): environment, the collection's base_url, then the values
  // kept on the request itself.
  const previewVars = () => ({
    ...varsForCol(collections.find((c) => c.id === collectionId)),
    ...requestVars(request),
  });

  // Where the open test lives, for the line above the panel. Null while it is
  // filed nowhere — there is no trail to show yet.
  const crumbFor = (r: SavedRequest) => {
    const col = collections.find((c) => c.id === collectionId);
    if (!col) return null;
    const fpath = folderPath(col.folders || [], r.folderId);
    return [col.name, ...(fpath ? [fpath] : []), r.name || 'Untitled'].join(' / ');
  };

  // ---- Auto-save: persist edits of a collection-bound request, debounced ----
  const collectionsRef = useRef(collections);
  useEffect(() => { collectionsRef.current = collections; }, [collections]);
  const skipAutoSave = useRef(true); // true while `request` was just loaded, not edited
  // Edits made here that the server has not accepted yet. The poll below refuses
  // to replace the open request while this is true, so an update arriving from
  // elsewhere can never overwrite something half-typed.
  const unsaved = useRef(false);

  useEffect(() => {
    if (skipAutoSave.current) { skipAutoSave.current = false; return undefined; }
    if (!collectionId) return undefined;
    unsaved.current = true;
    const timer = setTimeout(async () => {
      try {
        setSaveStatus('Saving…');
        // Only this request travels: the server merges it into whatever the
        // collection currently holds, so a folder renamed or a request added
        // since we last loaded survives our save.
        const saved = await api.putRequest(collectionId, request);
        setCollections((cols) => cols.map((c) => (c.id === saved.id ? saved : c)));
        unsaved.current = false;
        setSaveStatus('Saved');
      } catch (e) {
        console.error('auto-save failed:', e);
        // Left marked unsaved on purpose: these edits exist only here, so
        // nothing arriving from the server may take their place.
        setSaveStatus('Save failed');
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [request, collectionId]);

  // Held while a request is in flight so Send can turn into Cancel.
  const sendAbort = useRef<AbortController | null>(null);

  function cancelSend() {
    if (sendAbort.current) sendAbort.current.abort();
  }

  async function send() {
    if (sending) return; // Send is a Cancel button while one is in flight
    const controller = new AbortController();
    sendAbort.current = controller;
    setSending(true);
    setError(null);
    setResponse(null);
    setScriptResult(null);
    try {
      // The request travels as it stands and the server resolves it — the same
      // path MCP uses, so both send exactly the same thing. It goes inline
      // rather than by id because the editor's copy may hold edits that the
      // 600ms auto-save hasn't written yet.
      const out = await api.run({
        collection_id: collectionId || undefined,
        request,
        environment: activeEnvId || undefined,
      }, controller.signal);

      setResponse(out.response);
      if (out.script) {
        setScriptResult(out.script.error ? { error: out.script.error } : { saved: out.script.saved });
        // env.set() wrote into the active environment server-side.
        if (out.script.saved) setEnvironments(await api.listEnvironments());
      }
    } catch (e) {
      // An abort is the user's own doing, not a failure to report as one.
      setError((e as Error).name === 'AbortError' ? 'Request cancelled.' : (e as Error).message);
    } finally {
      sendAbort.current = null;
      setSending(false);
    }
  }

  // ---- Flows ----
  // Edits are debounced like a request's: a flow is one document, so the whole
  // thing is written each time.
  const flowRef = useRef(flow);
  useEffect(() => { flowRef.current = flow; }, [flow]);
  const skipFlowSave = useRef(true);
  const flowUnsaved = useRef(false);

  useEffect(() => {
    if (skipFlowSave.current) { skipFlowSave.current = false; return undefined; }
    if (!flow) return undefined;
    flowUnsaved.current = true;
    const timer = setTimeout(async () => {
      try {
        const saved = await api.saveFlow(flow);
        setFlows((fs) => fs.map((f) => (f.id === saved.id ? saved : f)));
        flowUnsaved.current = false;
      } catch (e) {
        console.error('flow save failed:', e);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [flow]);

  function openFlow(f: Flow) {
    skipFlowSave.current = true;
    flowUnsaved.current = false;
    setFlow(f);
    setFlowReport(null);
  }

  // ---- Keeping up with edits made elsewhere ----
  // This tab is not the only editor: Claude writes through MCP into the same
  // backend, and until now a screen loaded before that simply stayed wrong. The
  // server counts its writes, so ask for the count every few seconds and pull
  // the lists in when it moves. The poll sleeps while the tab is hidden and
  // checks the moment it comes back — which is exactly when you return to the
  // browser after telling Claude to change something.
  const requestRef = useRef(request);
  useEffect(() => { requestRef.current = request; }, [request]);
  const collectionIdRef = useRef(collectionId);
  useEffect(() => { collectionIdRef.current = collectionId; }, [collectionId]);

  useEffect(() => {
    let busy = false;
    // A flow is rewritten whole, so its updatedAt moves even when nothing about
    // it did; comparing without it keeps the open flow from being replaced by
    // an identical copy.
    const sameFlow = (a: Flow | null, b: Flow | null) => JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });

    async function check() {
      if (document.hidden || busy) return;
      busy = true;
      try {
        // Null until the first load has recorded one, and on a server too old
        // to answer /api/rev — in both cases there is nothing to compare to.
        if (seenRev.current === null) return;
        const { startedAt, rev } = await api.getRev();
        if (`${startedAt}:${rev}` === seenRev.current) return;

        // refresh() re-reads the counter as it reloads, so seenRev moves with it.
        const { collections: cols, flows: fls } = await refresh();

        // The open request may be one of the things that changed. Take the
        // server's copy only when nothing here is waiting to be saved: showing
        // an update a few seconds late is a far smaller sin than typing over
        // someone's unsaved edit.
        const col = cols.find((c) => c.id === collectionIdRef.current);
        const mine = requestRef.current;
        const theirs = col && (col.requests || []).find((r) => r.id === mine.id);
        if (theirs && !unsaved.current) {
          const next = normalizeRequest(theirs);
          if (JSON.stringify(next) !== JSON.stringify(mine)) {
            skipAutoSave.current = true;
            setRequest(next);
            setSaveStatus('Updated');
          }
        }

        const openF = flowRef.current;
        if (openF && !flowUnsaved.current) {
          const theirF = fls.find((f) => f.id === openF.id);
          if (theirF && !sameFlow(theirF, openF)) {
            skipFlowSave.current = true;
            setFlow(theirF);
          }
        }
      } catch {
        // Server restarting, or offline: the next tick tries again.
      } finally {
        busy = false;
      }
    }

    const timer = setInterval(check, 4000);
    const onWake = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [refresh]);

  async function newFlow(folderId: string | null = null) {
    const name = prompt('Flow name:', 'New Flow');
    if (!name) return;
    const saved = await api.saveFlow({ name, steps: [], folderId: folderId || null });
    setFlows((fs) => [...fs, saved]);
    openFlow(saved);
  }

  // Filing a flow somewhere else — dragged onto a folder in the sidebar. A flow
  // is written whole, so this reads the current one and puts it back with one
  // field changed.
  async function moveFlow(flowId: string, folderId: string | null) {
    const target = flows.find((f) => f.id === flowId);
    if (!target || (target.folderId || null) === (folderId || null)) return;
    // The open flow may hold edits the debounce has not written yet. Moving it
    // through the editor's own state lets that same save carry the move, rather
    // than racing it with a stale copy from the list.
    if (flow && flow.id === flowId) {
      setFlow({ ...flow, folderId: folderId || null });
      setFlows((fs) => fs.map((f) => (f.id === flowId ? { ...f, folderId: folderId || null } : f)));
      return;
    }
    const saved = await api.saveFlow({ ...target, folderId: folderId || null });
    setFlows((fs) => fs.map((f) => (f.id === saved.id ? saved : f)));
  }

  // ---- Flow folders ----
  async function newFlowFolder(parentId: string | null = null) {
    const name = prompt('Folder name:', 'New Folder');
    if (!name) return;
    await api.createFlowFolder({ name, parentId: parentId || null });
    await refresh();
  }

  async function renameFlowFolder(folder: Folder) {
    const name = prompt('Rename folder:', folder.name);
    if (!name || name === folder.name) return;
    await api.patchFlowFolder(folder.id, { name });
    await refresh();
  }

  async function deleteFlowFolder(folder: Folder) {
    // Say how many flows go with it: a folder's name doesn't tell you, and a
    // flow is a lot of work to rebuild.
    const doomed = folderWithDescendants(flowFolders, folder.id);
    const count = flows.filter((f) => doomed.includes(f.folderId as string)).length;
    const what = count
      ? `Delete folder "${folder.name}" and the ${count} flow${count > 1 ? 's' : ''} inside it?`
      : `Delete folder "${folder.name}"?`;
    if (!confirm(what)) return;
    const { deletedFlows } = await api.deleteFlowFolder(folder.id);
    // Whatever was open may have just been deleted with it.
    if (flow && deletedFlows.includes(flow.id)) {
      setFlow(null);
      setFlowReport(null);
    }
    await refresh();
  }

  async function deleteFlow() {
    if (!flow) return;
    if (!confirm(`Delete flow "${flow.name}"?`)) return;
    await api.deleteFlow(flow.id);
    setFlows((fs) => fs.filter((f) => f.id !== flow.id));
    setFlow(null);
    setFlowReport(null);
  }

  async function runFlow() {
    if (!flow) return;
    setFlowRunning(true);
    setFlowReport(null);
    try {
      // Save first: the report is only meaningful for the steps as they stand.
      const saved = await api.saveFlow(flow);
      setFlows((fs) => fs.map((f) => (f.id === saved.id ? saved : f)));
      setFlowReport(await api.runFlow(saved.id, { environment: activeEnvId || undefined }));
    } catch (e) {
      setFlowReport({ ok: false, durationMs: 0, steps: [], vars: {}, error: (e as Error).message });
      alert(`Could not run the flow: ${(e as Error).message}`);
    } finally {
      setFlowRunning(false);
    }
  }

  // Run a single step. Its result replaces that step's row and leaves every
  // other row showing what it already showed — this run answers for one step,
  // so it must not claim to have re-answered for the rest.
  async function runStep(stepId: string) {
    if (!flow) return;
    setRunningStep(stepId);
    try {
      // Save first, as a full run does: the result is only meaningful for the
      // step as it stands right now.
      const saved = await api.saveFlow(flow);
      setFlows((fs) => fs.map((f) => (f.id === saved.id ? saved : f)));
      const rep = await api.runFlowStep(saved.id, stepId, { environment: activeEnvId || undefined });
      const entry = rep.steps[0];
      setFlowReport((prev) => {
        const kept = (prev && prev.steps) || [];
        return {
          ...rep,
          steps: kept.some((s) => s.id === stepId)
            ? kept.map((s) => (s.id === stepId ? entry : s))
            : [...kept, entry],
          vars: { ...(prev && prev.vars), ...rep.vars },
          // What the summary bar reports on, so it says "step" rather than
          // passing a one-step run off as the whole flow.
          oneStep: stepId,
        };
      });
    } catch (e) {
      alert(`Could not run the step: ${(e as Error).message}`);
    } finally {
      setRunningStep(null);
    }
  }

  // ---- Collections / requests ----
  // Save the open request under a name into a chosen (possibly new)
  // collection; choosing a different collection moves it there.
  async function saveRequestTo(
    { name, collectionId: targetId, newCollectionName, folderId }: SaveTarget,
  ) {
    const named = { ...request, name, folderId: folderId || null };
    let target;
    if (newCollectionName != null) {
      target = await api.createCollection({ name: newCollectionName, requests: [] });
    } else {
      target = (await api.listCollections()).find((c) => c.id === targetId);
      if (!target) throw new Error('Collection no longer exists');
    }
    // Land it in the new home before unfiling it from the old one, so a
    // failure in between leaves a duplicate rather than nothing.
    await api.putRequest(target.id, named);
    if (collectionId && collectionId !== target.id) {
      await api.deleteRequest(collectionId, named.id);
    }
    skipAutoSave.current = true;
    unsaved.current = false;
    setRequest(named);
    setCollectionId(target.id);
    setSaveStatus('Saved');
    setSaveModalOpen(false);
    await refresh();
  }

  // Create a fresh request inside a collection (optionally in a folder) and open it.
  async function newRequestIn(col: Collection, folderId: string | null = null) {
    return createIn(col, folderId, newRequest());
  }

  // The same, for a test that runs a command. It is filed in the collection
  // like any other test: it proves something about the same feature, and a
  // flow points a step at it exactly as it points one at a request.
  async function newShellTestIn(col: Collection, folderId: string | null = null) {
    return createIn(col, folderId, newShellTest());
  }

  async function createIn(col: Collection, folderId: string | null, draft: SavedRequest) {
    const r = { ...draft, folderId: folderId || null };
    await api.putRequest(col.id, r);
    skipAutoSave.current = true;
    unsaved.current = false;
    setFlow(null);
    setRequest(r);
    setCollectionId(col.id);
    setResponse(null);
    setError(null);
    setSaveStatus('Saved');
    await refresh();
  }

  // ---- Folders ----
  async function newFolder(col: Collection, parentId: string | null = null) {
    const name = prompt('Folder name:', 'New Folder');
    if (!name) return;
    await api.createFolder(col.id, { id: uid(), name, parentId: parentId || null });
    await refresh();
  }

  async function renameFolder(col: Collection, folder: Folder) {
    const name = prompt('Rename folder:', folder.name);
    if (!name || name === folder.name) return;
    await api.patchFolder(col.id, folder.id, { name });
    await refresh();
  }

  async function deleteFolder(col: Collection, folder: Folder) {
    if (!confirm(`Delete folder "${folder.name}" and everything inside it?`)) return;
    // Which requests went with it is decided on the server, in the same write
    // that removes the folders — and it answers with the collection as it now
    // stands. Ask that, rather than working the same cascade out a second time
    // here from a copy that may already be stale.
    const updated = await api.deleteFolder(col.id, folder.id);
    if (collectionId === col.id && !(updated.requests || []).some((r) => r.id === request.id)) {
      setCollectionId(null);
    }
    await refresh();
  }

  // Part of this workspace, or all of it, as one file for a second machine to
  // import. What goes in is picked in the modal; the button only opens it.
  function exportAll() {
    setTransfer({
      mode: 'export',
      counts: {
        tests: collections.length,
        flows: flows.length,
        environments: environments.length,
      },
    });
  }

  async function runExport(include: string[]) {
    setTransfer(null);
    try {
      const data = await api.exportAll(include);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      );
      const a = document.createElement('a');
      a.href = url;
      // The scope in the name: three files in a downloads folder are otherwise
      // told apart only by opening them.
      const scope = include.length === 3 ? '' : `-${include.join('-')}`;
      a.download = `testing-tool${scope}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
    }
  }

  // One of our own export files: restore it onto this machine. Same ids as the
  // machine it came from, so a second import updates rather than duplicates.
  // A section the file doesn't carry is left out of the picker entirely — the
  // counts here are what is in the file, not what is in this workspace.
  function importWorkspace(data: Record<string, unknown>) {
    const counts: Record<string, number> = {};
    if (Array.isArray(data.collections)) counts.tests = data.collections.length;
    if (Array.isArray(data.flows)) counts.flows = data.flows.length;
    if (Array.isArray(data.environments)) counts.environments = data.environments.length;
    if (!Object.keys(counts).length) {
      alert('That export file carries no tests, flows or environments.');
      return;
    }
    setTransfer({ mode: 'import', counts, exportedAt: data.exportedAt as string | undefined, data });
  }

  // What /api/import/workspace reports back. Every section is optional: one
  // left out of the transfer has no key here at all, rather than a zero.
  interface ImportResult {
    applied?: string[];
    collections?: { added: number; updated: number };
    flows?: { added: number; updated: number };
    environments?: { added: number; updated: number };
    flowFolders?: number;
    baseUrls?: number;
    fileFields?: number;
    missingRequests?: { steps: number; flows: string[] };
  }

  async function runImport(data: Record<string, unknown> | undefined, include: string[]) {
    setTransfer(null);
    try {
      const r = await api.importWorkspace(data, include) as ImportResult;
      await refresh();
      const line = (name: string, c: { added: number; updated: number }) =>
        `${name}: ${c.added} added, ${c.updated} updated`;
      const lines: string[] = [];
      if (r.collections) lines.push(line('Tests', r.collections));
      if (r.flows) lines.push(line('Flows', r.flows));
      if (r.environments) lines.push(line('Environments', r.environments));
      if (r.baseUrls !== undefined) lines.push(`Base URLs: ${r.baseUrls} added`);
      if (!lines.length) lines.push('Nothing imported.');
      if (r.fileFields) {
        lines.push(
          '',
          `${r.fileFields} form-data file field(s) point at uploads that stayed on the other `
          + 'machine — pick those files again here.'
        );
      }
      // Flows whose steps name a saved request this machine hasn't got: they
      // will fail on that step, so say it now rather than at the first run.
      if (r.missingRequests) {
        lines.push(
          '',
          `${r.missingRequests.steps} step(s) in ${r.missingRequests.flows.join(', ')} `
          + 'run a saved request that is not on this machine — import the Tests too.'
        );
      }
      alert(lines.join('\n'));
    } catch (e) {
      alert(`Import failed: ${(e as Error).message}`);
    }
  }

  // The import button takes either format; which one it is, is in the file.
  function importFile(data: Record<string, unknown>) {
    if (data && (data.format === 'testing-tool/workspace' || data.format === 'api-test/workspace')) {
      return importWorkspace(data);
    }
    return importPostman(data);
  }

  // What /api/import/postman reports back: a collection import, or an
  // environment one, which carries a variable count instead of requests.
  interface PostmanImportResult {
    type: 'collection' | 'environment';
    collections?: string[];
    requests?: number;
    folders?: number;
    baseUrl?: string;
    name?: string;
    variables?: number;
  }

  async function importPostman(data: Record<string, unknown>) {
    try {
      const result = await api.importPostman(data) as unknown as PostmanImportResult;
      await refresh();
      if (result.type === 'environment') {
        alert(`Imported environment "${result.name}" (${result.variables} variables).`);
      } else {
        const lines = [
          `Imported ${result.requests} requests in ${result.folders} folders `
          + `into ${(result.collections || []).join(', ')}.`,
        ];
        // An export that names its host with a {{variable}} carries no value
        // for it, so say what has to be defined before anything will resolve.
        if (result.baseUrl) {
          lines.push('', `Base URL: ${result.baseUrl}`);
          const token = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(result.baseUrl);
          if (token) lines.push(`Set "${token[1]}" in an environment to point the collection somewhere.`);
        }
        alert(lines.join('\n'));
      }
    } catch (e) {
      alert(`Import failed: ${(e as Error).message}`);
    }
  }

  async function renameRequest(col: Collection, r: SavedRequest) {
    const name = prompt('Request name:', r.name || '');
    if (!name || name === r.name) return;
    await api.patchRequest(col.id, r.id, { name });
    if (request.id === r.id) {
      skipAutoSave.current = true;
      setRequest({ ...request, name });
    }
    await refresh();
  }

  // Filing a request under a different folder of its collection — dragged there
  // in the sidebar. This is a route change as much as a filing one: {{dy_url}}
  // expands to the folder path, so the request now points somewhere else, which
  // is the whole reason for moving it.
  async function moveRequest(colId: string, requestId: string, folderId: string | null) {
    const col = collections.find((c) => c.id === colId);
    const r = col && (col.requests || []).find((x) => x.id === requestId);
    if (!r || (r.folderId || null) === (folderId || null)) return;
    await api.patchRequest(colId, requestId, { folderId: folderId || null });
    // The open request keeps its own copy. Patch the one field, the way a
    // rename does, so edits waiting to be saved are not thrown away.
    if (request.id === requestId) {
      skipAutoSave.current = true;
      setRequest({ ...request, folderId: folderId || null });
    }
    await refresh();
  }

  function openRequest(col: Collection, r: SavedRequest) {
    setFlow(null); // the main area shows either a request or a flow
    skipAutoSave.current = true;
    unsaved.current = false;
    setRequest(normalizeRequest(r));
    setCollectionId(col.id);
    setResponse(null);
    setError(null);
    setSaveStatus('Saved');
  }

  // A blank request in the panel, filed nowhere and written nowhere — the one
  // you type into to try something, and save afterwards if it was worth
  // keeping. The plus inside a collection is the other thing: that one creates
  // the request in the collection straight away.
  function newReq(draft: SavedRequest = newRequest()) {
    setFlow(null);
    skipAutoSave.current = true;
    unsaved.current = false;
    setRequest(draft);
    setCollectionId(null);
    setResponse(null);
    setError(null);
    setSaveStatus('');
  }

  async function newCollection() {
    const name = prompt('Collection name:', 'New Collection');
    if (!name) return;
    await api.createCollection({ name, requests: [] });
    await refresh();
  }

  // The open collection's base_url, edited from the env bar.
  async function saveCollectionBaseUrl(baseUrl: string) {
    if (!collectionId) return;
    const saved = await api.patchCollection(collectionId, { baseUrl });
    setCollections((cols) => cols.map((c) => (c.id === saved.id ? saved : c)));
  }

  async function saveCollectionSettings(fields: Partial<Collection>) {
    if (!settingsCol) return;
    await api.patchCollection(settingsCol.id, fields);
    setSettingsCol(null);
    await refresh();
  }

  async function deleteCollection(col: Collection) {
    if (!confirm(`Delete collection "${col.name}" and all its requests?`)) return;
    await api.deleteCollection(col.id);
    if (collectionId === col.id) setCollectionId(null);
    await refresh();
  }

  async function deleteRequest(col: Collection, r: SavedRequest) {
    if (!confirm(`Delete request "${r.name || ('url' in r ? r.url : '') || 'Untitled'}"?`)) return;
    await api.deleteRequest(col.id, r.id);
    // Detach the panel when it holds the request just deleted: auto-save adds
    // back any open request missing from its collection, so leaving it bound
    // would resurrect it on the next keystroke. Detached, the content stays on
    // screen and Save can re-file it — same as deleting its collection.
    if (collectionId === col.id && request.id === r.id) {
      setCollectionId(null);
      setSaveStatus('');
    }
    await refresh();
  }

  return (
    <div className="app">
      <Sidebar
        collections={collections}
        activeRequestId={request.id}
        onNewRequest={() => newReq()}
        onNewShellTest={() => newReq(newShellTest())}
        onNewShellTestIn={newShellTestIn}
        onOpenRequest={openRequest}
        onNewCollection={newCollection}
        onOpenCollectionSettings={setSettingsCol}
        onDeleteCollection={deleteCollection}
        onDeleteRequest={deleteRequest}
        onRenameRequest={renameRequest}
        onMoveRequest={moveRequest}
        onNewRequestIn={newRequestIn}
        onNewFolder={newFolder}
        onRenameFolder={renameFolder}
        onDeleteFolder={deleteFolder}
        onImport={importFile}
        onExport={exportAll}
        flows={flows}
        flowFolders={flowFolders}
        activeFlowId={flow ? flow.id : null}
        onOpenFlow={openFlow}
        onNewFlow={newFlow}
        onMoveFlow={moveFlow}
        onNewFlowFolder={newFlowFolder}
        onRenameFlowFolder={renameFlowFolder}
        onDeleteFlowFolder={deleteFlowFolder}
      />

      <main className="main">
        <EnvironmentBar
          environments={environments}
          activeEnvId={activeEnvId}
          onSelect={setActiveEnvId}
          collections={collections}
          collection={collections.find((c) => c.id === collectionId) || null}
          envBaseUrl={activeVars().base_url}
          onSaveBaseUrl={saveCollectionBaseUrl}
          savedBaseUrls={savedBaseUrls}
          onSaveBaseUrls={async (list: string[]) => setSavedBaseUrls(await api.saveBaseUrls(list))}
          onSaveEnv={async (e: Partial<Environment>) => {
            const saved = await api.saveEnvironment(e);
            await refresh();
            if (!e.id) setActiveEnvId(saved.id); // select a freshly created env
          }}
          onDeleteEnv={async (id: string) => {
            await api.deleteEnvironment(id);
            if (activeEnvId === id) setActiveEnvId(null);
            await refresh();
          }}
        />
        {flow ? (
          <FlowPanel
            flow={flow}
            collections={collections}
            onChange={setFlow}
            onRun={runFlow}
            onRunStep={runStep}
            onDelete={deleteFlow}
            running={flowRunning}
            runningStep={runningStep}
            report={flowReport}
          />
        ) : isShellTest(request) ? (
          <>
        <ShellTestPanel
          test={request}
          onChange={setRequest}
          onRun={send}
          onCancel={cancelSend}
          onSave={() => setSaveModalOpen(true)}
          running={sending}
          saveStatus={collectionId ? saveStatus : ''}
          vars={previewVars()}
          envVars={varsForCol(collections.find((c) => c.id === collectionId))}
          resolvedCommand={(() => {
            const resolved = substitute(request.command || '', previewVars());
            return resolved !== (request.command || '') ? resolved : '';
          })()}
          crumb={crumbFor(request)}
        />
        {saveModalOpen && (
          <SaveRequestModal
            request={request}
            collections={collections}
            currentCollectionId={collectionId}
            onSave={saveRequestTo}
            onCancel={() => setSaveModalOpen(false)}
          />
        )}
        {settingsCol && (
          <CollectionSettingsModal
            collection={settingsCol}
            onSave={saveCollectionSettings}
            onCancel={() => setSettingsCol(null)}
          />
        )}
        <ResponsePanel
          response={response}
          error={error}
          sending={sending}
          scriptResult={scriptResult}
          busyText="Running the command…"
          emptyText="What the command printed will appear here"
        />
        </>
        ) : (
          <>
        <RequestPanel
          request={request}
          onChange={setRequest}
          onSend={send}
          onCancel={cancelSend}
          onSave={() => setSaveModalOpen(true)}
          sending={sending}
          onUploadFile={api.uploadFile}
          saveStatus={collectionId ? saveStatus : ''}
          vars={previewVars()}
          envVars={varsForCol(collections.find((c) => c.id === collectionId))}
          urlVars={(() => {
            const col = collections.find((c) => c.id === collectionId);
            const vars = previewVars();
            // Show {{dy_url}} as a valid token whose tooltip reveals its full
            // expansion, with {{base_url}} resolved to its actual value too.
            return { ...vars, dy_url: substitute(dyUrl(col ? col.folders || [] : [], request.folderId), vars) };
          })()}
          composedUrl={(() => {
            const col = collections.find((c) => c.id === collectionId);
            const composed = composeUrl(col ? col.folders || [] : [], request.folderId, request.url) || '';
            return composed !== request.url ? substitute(composed, previewVars()) : null;
          })()}
          auth={(() => {
            const col = collections.find((c) => c.id === collectionId);
            return describeAuth(col, request, previewVars());
          })()}
          collectionName={(collections.find((c) => c.id === collectionId) || {}).name}
          crumb={crumbFor(request)}
        />
        {saveModalOpen && (
          <SaveRequestModal
            request={request}
            collections={collections}
            currentCollectionId={collectionId}
            onSave={saveRequestTo}
            onCancel={() => setSaveModalOpen(false)}
          />
        )}
        {settingsCol && (
          <CollectionSettingsModal
            collection={settingsCol}
            onSave={saveCollectionSettings}
            onCancel={() => setSettingsCol(null)}
          />
        )}
        <ResponsePanel response={response} error={error} sending={sending} scriptResult={scriptResult} />
        </>
        )}
      </main>

      {/* Outside <main>: import and export are reachable from the flow view as
          well as the request view. */}
      {transfer && (
        <TransferModal
          mode={transfer.mode}
          counts={transfer.counts}
          exportedAt={transfer.exportedAt}
          onCancel={() => setTransfer(null)}
          onConfirm={(include: string[]) => (transfer.mode === 'import'
            ? runImport(transfer.data, include)
            : runExport(include))}
        />
      )}
    </div>
  );
}
