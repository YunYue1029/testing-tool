import { useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar.tsx';
import RequestPanel from './components/RequestPanel.tsx';
import ResponsePanel from './components/ResponsePanel.tsx';
import EnvironmentBar from './components/EnvironmentBar.tsx';
import SaveRequestModal from './components/SaveRequestModal.tsx';
import CollectionSettingsModal from './components/CollectionSettingsModal.tsx';
import TransferModal from './components/TransferModal.tsx';
import FlowPanel from './components/FlowPanel.tsx';
import ShellTestPanel from './components/ShellTestPanel.tsx';
import { api } from './api.ts';
import useWorkspace from './useWorkspace.ts';
import useRequestDraft from './useRequestDraft.ts';
import useFlowDraft from './useFlowDraft.ts';
import useEvents from './useEvents.ts';
import {
  describeImport, downloadExport, importPostman, importWorkspace, isWorkspaceFile,
} from './transfer.ts';
import type { TransferState } from './transfer.ts';
// What remains here is preview only — composing the URL shown under the bar,
// highlighting {{vars}}, describing auth. Building the request that actually
// goes out is the server's job (server/runner.ts, through server/resolve.ts,
// whose functions util.ts re-exports so the preview cannot drift from it).
import {
  newRequest, newShellTest, isShellTest, normalizeRequest, substitute,
  newId, folderPath, folderWithDescendants, composeUrl, dyUrl, DEFAULT_BASE_URL,
  applyCollectionBaseUrl, describeAuth, requestVars, buildUrl,
} from './util.ts';
import type { Collection, Environment, Flow, Folder, SavedRequest, Vars } from './types.ts';

// What the save dialog answers with: where to file the request, and the name
// to file it under. `newCollectionName` is set instead of `collectionId` when
// the collection is being created on the spot.
interface SaveTarget {
  name: string;
  collectionId?: string | null;
  newCollectionName?: string;
  folderId?: string | null;
}

// An environment's variables as substitution sees them: the disabled ones
// left out, and base_url filled in from the built-in default when the
// environment does not set its own.
function envVarsOf(environments: Environment[], envId: string | null): Vars {
  const env = environments.find((e) => e.id === envId);
  const vars = env ? { ...(env.variables || {}) } : {};
  if (env) for (const k of env.disabled || []) delete vars[k];
  if (vars.base_url == null || vars.base_url === '') vars.base_url = DEFAULT_BASE_URL;
  return vars;
}

export default function App() {
  const [activeEnvId, setActiveEnvId] = useState(
    () => localStorage.getItem('activeEnvId') || null
  );
  // Something the server refused, said once at the bottom of the screen
  // until dismissed — the response panel's error is the last send's, and the
  // next send clears it, which is no place for "the folder was not renamed".
  const [notice, setNotice] = useState<string | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [settingsColId, setSettingsColId] = useState<string | null>(null); // collection being configured
  const [transfer, setTransfer] = useState<TransferState | null>(null);

  const ws = useWorkspace(
    // The open request or flow may be among what changed; each takes the
    // server's copy unless it has edits of its own waiting.
    (loaded) => { req.takeUpdate(loaded.collections); fd.takeUpdate(loaded.flows); },
    (message) => setNotice(`Could not load the workspace: ${message}`),
  );
  const { collections, environments, flows, flowFolders } = ws;
  const req = useRequestDraft({
    activeEnvId, putCollection: ws.putCollection, setEnvironments: ws.setEnvironments,
  });
  const { request, collectionId } = req;
  const fd = useFlowDraft({ putFlow: ws.putFlow });
  const { flow } = fd;

  useEffect(() => {
    if (activeEnvId) localStorage.setItem('activeEnvId', activeEnvId);
    else localStorage.removeItem('activeEnvId');
  }, [activeEnvId]);

  // A handler that talks to the server and fails: said in the notice, under
  // what it was trying to do, rather than swallowed. Every handler below that
  // the sidebar or a bar calls goes through this.
  function attempt<A extends unknown[]>(what: string, fn: (...args: A) => Promise<void>) {
    return async (...args: A) => {
      try {
        await fn(...args);
      } catch (e) {
        setNotice(`${what}: ${(e as Error).message}`);
      }
    };
  }

  // The environment the open flow runs in: its own, when it names one that
  // still exists, pinning it whatever the bar above says; otherwise the bar's.
  // Its runs, url preview and vars all read this one.
  const flowEnvId = flow && flow.environmentId
    && environments.some((e) => e.id === flow.environmentId)
    ? flow.environmentId
    : activeEnvId;

  // The collection the open request lives in, and what the request panel
  // previews with — the same order the server resolves in (see runRequest):
  // environment, the collection's base_url, then the values kept on the
  // request itself. Once per render: half a dozen props read them.
  const col = useMemo(
    () => collections.find((c) => c.id === collectionId) || null,
    [collections, collectionId],
  );
  const envVars = useMemo(
    () => applyCollectionBaseUrl(envVarsOf(environments, activeEnvId), col),
    [environments, activeEnvId, col],
  );
  const previewVars = useMemo(
    () => ({ ...envVars, ...requestVars(request, activeEnvId) }),
    [envVars, request, activeEnvId],
  );

  // Where the open test lives, for the line above the panel. Null while it is
  // filed nowhere — there is no trail to show yet.
  const crumb = col
    ? [col.name, ...[folderPath(col.folders || [], request.folderId)].filter(Boolean), request.name || 'Untitled'].join(' / ')
    : null;

  // ---- Flows ----
  const newFlow = attempt('Could not create the flow', async (folderId: string | null = null) => {
    const name = prompt('Flow name:', 'New Flow');
    if (!name) return;
    const saved = await api.saveFlow({ name, steps: [], folderId: folderId || null });
    ws.putFlow(saved);
    await openFlow(saved);
  });

  // Filing a flow somewhere else — dragged onto a folder in the sidebar. A flow
  // is written whole, so this reads the current one and puts it back with one
  // field changed.
  const moveFlow = attempt('Could not move the flow', async (flowId: string, folderId: string | null) => {
    const target = flows.find((f) => f.id === flowId);
    if (!target || (target.folderId || null) === (folderId || null)) return;
    // The open flow may hold edits the debounce has not written yet. Moving it
    // through the editor's own state lets that same save carry the move, rather
    // than racing it with a stale copy from the list.
    if (flow && flow.id === flowId) {
      fd.edit({ ...flow, folderId: folderId || null });
      ws.putFlow({ ...target, folderId: folderId || null });
      return;
    }
    ws.putFlow(await api.saveFlow({ ...target, folderId: folderId || null }));
  });

  // ---- Flow folders ----
  const newFlowFolder = attempt('Could not create the folder', async (parentId: string | null = null) => {
    const name = prompt('Folder name:', 'New Folder');
    if (!name) return;
    const { folders } = await api.createFlowFolder({ name, parentId: parentId || null });
    ws.setFlowFolders(folders);
  });

  // Refiling a whole folder — dragged onto another one, or onto the Flows
  // header to bring it back up to the top level. Only the folder's own parent
  // changes: everything under it is filed by parent too, so the subtree comes
  // along without being touched.
  const moveFlowFolder = attempt('Could not move the folder', async (folderId: string, parentId: string | null) => {
    const target = flowFolders.find((f) => f.id === folderId);
    if (!target || (target.parentId || null) === (parentId || null)) return;
    // The sidebar already refuses this drop; the check is here as well because
    // a folder inside its own subtree would be lost — still in the file, and
    // reachable from nothing.
    if (parentId && folderWithDescendants(flowFolders, folderId).includes(parentId)) return;
    ws.setFlowFolders(await api.patchFlowFolder(folderId, { parentId: parentId || null }));
  });

  const renameFlowFolder = attempt('Could not rename the folder', async (folder: Folder) => {
    const name = prompt('Rename folder:', folder.name);
    if (!name || name === folder.name) return;
    ws.setFlowFolders(await api.patchFlowFolder(folder.id, { name }));
  });

  const deleteFlowFolder = attempt('Could not delete the folder', async (folder: Folder) => {
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
    fd.forgetReports(deletedFlows);
    if (flow && deletedFlows.includes(flow.id)) fd.discard();
    await ws.refresh();
  });

  const deleteFlow = attempt('Could not delete the flow', async () => {
    if (!flow) return;
    if (!confirm(`Delete flow "${flow.name}"?`)) return;
    await api.deleteFlow(flow.id);
    ws.setFlows((fs) => fs.filter((f) => f.id !== flow.id));
    fd.forgetReports([flow.id]);
    fd.discard();
  });

  async function openFlow(f: Flow) {
    // The request's pending edit is written on the way out; nothing here
    // should have to be re-typed because a flow was opened.
    await req.flush();
    await fd.open(f);
  }

  // ---- Collections / requests ----
  // Save the open request under a name into a chosen (possibly new)
  // collection; choosing a different collection moves it there.
  async function saveRequestTo(
    { name, collectionId: targetId, newCollectionName, folderId }: SaveTarget,
  ) {
    const named = { ...request, name, folderId: folderId || null };
    let target: Collection | undefined;
    if (newCollectionName != null) {
      target = await api.createCollection({ name: newCollectionName, requests: [] });
    } else {
      target = (await api.listCollections()).find((c) => c.id === targetId);
      if (!target) throw new Error('Collection no longer exists');
    }
    // Land it in the new home before unfiling it from the old one, so a
    // failure in between leaves a duplicate rather than nothing.
    ws.putCollection(await api.putRequest(target.id, named));
    if (collectionId && collectionId !== target.id) {
      ws.putCollection(await api.deleteRequest(collectionId, named.id));
    }
    // This write carried every edit, so nothing pending is flushed first.
    req.replace(target.id, named, 'Saved');
    setSaveModalOpen(false);
  }

  // Create a fresh request inside a collection (optionally in a folder) and open it.
  const newRequestIn = (c: Collection, folderId: string | null = null) => createIn(c, folderId, newRequest());

  // The same, for a test that runs a command. It is filed in the collection
  // like any other test: it proves something about the same feature, and a
  // flow points a step at it exactly as it points one at a request.
  const newShellTestIn = (c: Collection, folderId: string | null = null) => createIn(c, folderId, newShellTest());

  const createIn = attempt('Could not create the request', async (c: Collection, folderId: string | null, draft: SavedRequest) => {
    const r = { ...draft, folderId: folderId || null };
    ws.putCollection(await api.putRequest(c.id, r));
    await fd.close(); // the main area shows either a request or a flow
    await req.open(c.id, r, 'Saved');
  });

  // ---- Folders ----
  const newFolder = attempt('Could not create the folder', async (c: Collection, parentId: string | null = null) => {
    const name = prompt('Folder name:', 'New Folder');
    if (!name) return;
    ws.putCollection(await api.createFolder(c.id, { id: newId(), name, parentId: parentId || null }));
  });

  const renameFolder = attempt('Could not rename the folder', async (c: Collection, folder: Folder) => {
    const name = prompt('Rename folder:', folder.name);
    if (!name || name === folder.name) return;
    ws.putCollection(await api.patchFolder(c.id, folder.id, { name }));
  });

  const deleteFolder = attempt('Could not delete the folder', async (c: Collection, folder: Folder) => {
    if (!confirm(`Delete folder "${folder.name}" and everything inside it?`)) return;
    // Which requests went with it is decided on the server, in the same write
    // that removes the folders — and it answers with the collection as it now
    // stands. Ask that, rather than working the same cascade out a second time
    // here from a copy that may already be stale.
    const updated = await api.deleteFolder(c.id, folder.id);
    ws.putCollection(updated);
    if (collectionId === c.id && !(updated.requests || []).some((r) => r.id === request.id)) {
      req.detach();
    }
  });

  // ---- Export / import ----
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
      await downloadExport(include);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
    }
  }

  // The import button takes either format; which one it is, is in the file.
  // One of ours goes through the picker; a Postman file is written as it is.
  function importFile(data: Record<string, unknown>) {
    if (!isWorkspaceFile(data)) { void runPostmanImport(data); return; }
    const picked = describeImport(data);
    if (!picked) { alert('That export file carries no tests, flows or environments.'); return; }
    setTransfer(picked);
  }

  async function runImport(data: Record<string, unknown> | undefined, include: string[]) {
    setTransfer(null);
    try {
      const summary = await importWorkspace(data, include);
      await ws.refresh();
      alert(summary);
    } catch (e) {
      alert(`Import failed: ${(e as Error).message}`);
    }
  }

  async function runPostmanImport(data: Record<string, unknown>) {
    try {
      const summary = await importPostman(data);
      await ws.refresh();
      alert(summary);
    } catch (e) {
      alert(`Import failed: ${(e as Error).message}`);
    }
  }

  const renameRequest = attempt('Could not rename the request', async (c: Collection, r: SavedRequest) => {
    const name = prompt('Request name:', r.name || '');
    if (!name || name === r.name) return;
    ws.putCollection(await api.patchRequest(c.id, r.id, { name }));
    // The open request keeps its own copy. Patch the one field, so edits
    // waiting to be saved are not thrown away — and ride along with them.
    if (request.id === r.id) req.patch((cur) => ({ ...cur, name }));
  });

  // Filing a request under a different folder of its collection — dragged there
  // in the sidebar. This is a route change as much as a filing one: {{dy_url}}
  // expands to the folder path, so the request now points somewhere else, which
  // is the whole reason for moving it.
  const moveRequest = attempt('Could not move the request', async (colId: string, requestId: string, folderId: string | null) => {
    const c = collections.find((x) => x.id === colId);
    const r = c && (c.requests || []).find((x) => x.id === requestId);
    if (!r || (r.folderId || null) === (folderId || null)) return;
    ws.putCollection(await api.patchRequest(colId, requestId, { folderId: folderId || null }));
    if (request.id === requestId) req.patch((cur) => ({ ...cur, folderId: folderId || null }));
  });

  async function openRequest(c: Collection, r: SavedRequest) {
    await fd.close(); // the main area shows either a request or a flow
    await req.open(c.id, normalizeRequest(r), 'Saved');
  }

  // A blank request in the panel, filed nowhere and written nowhere — the one
  // you type into to try something, and save afterwards if it was worth
  // keeping. The plus inside a collection is the other thing: that one creates
  // the request in the collection straight away.
  async function newReq(draft: SavedRequest = newRequest()) {
    await fd.close();
    await req.open(null, draft, '');
  }

  const newCollection = attempt('Could not create the collection', async () => {
    const name = prompt('Collection name:', 'New Collection');
    if (!name) return;
    ws.putCollection(await api.createCollection({ name, requests: [] }));
  });

  // Written as the dialog is edited, so it stays open afterwards: closing it is
  // the Close button's job, not a save's.
  async function saveCollectionSettings(fields: Partial<Collection>) {
    if (!settingsColId) return;
    ws.putCollection(await api.patchCollection(settingsColId, fields));
  }

  const deleteCollection = attempt('Could not delete the collection', async (c: Collection) => {
    if (!confirm(`Delete collection "${c.name}" and all its requests?`)) return;
    await api.deleteCollection(c.id);
    ws.setCollections((cols) => cols.filter((x) => x.id !== c.id));
    if (collectionId === c.id) req.detach();
  });

  const deleteRequest = attempt('Could not delete the request', async (c: Collection, r: SavedRequest) => {
    if (!confirm(`Delete request "${r.name || ('url' in r ? r.url : '') || 'Untitled'}"?`)) return;
    ws.putCollection(await api.deleteRequest(c.id, r.id));
    // Detach the panel when it holds the request just deleted: auto-save adds
    // back any open request missing from its collection, so leaving it bound
    // would resurrect it on the next keystroke. Detached, the content stays on
    // screen and Save can re-file it — same as deleting its collection.
    if (collectionId === c.id && request.id === r.id) req.detach();
  });

  // ---- Environments ----
  async function onSaveEnv(e: Partial<Environment>) {
    const saved = await api.saveEnvironment(e);
    ws.putEnvironment(saved);
    if (!e.id) setActiveEnvId(saved.id); // select a freshly created env
    // Handed back so the editor knows which environment it is now
    // writing to, rather than creating another on the next keystroke.
    return saved;
  }

  const onDeleteEnv = attempt('Could not delete the environment', async (id: string) => {
    await api.deleteEnvironment(id);
    ws.setEnvironments((envs) => envs.filter((e) => e.id !== id));
    if (activeEnvId === id) setActiveEnvId(null);
  });

  // The sidebar is memoised, and a keystroke in the request panel must not
  // re-render its whole tree: these handlers keep one identity across
  // renders, and the environment bar is only rebuilt when its inputs move.
  const envHandlers = useEvents({ onSaveEnv, onDeleteEnv });
  const envBar = useMemo(() => (
    <EnvironmentBar
      environments={environments}
      activeEnvId={activeEnvId}
      onSelect={setActiveEnvId}
      collections={collections}
      onSaveEnv={envHandlers.onSaveEnv}
      onDeleteEnv={envHandlers.onDeleteEnv}
    />
  ), [environments, activeEnvId, collections, envHandlers]);
  const side = useEvents({
    onNewRequest: () => { void newReq(); },
    onNewShellTest: () => { void newReq(newShellTest()); },
    onNewShellTestIn: newShellTestIn,
    onOpenRequest: openRequest,
    onNewCollection: newCollection,
    onOpenCollectionSettings: (c: Collection) => setSettingsColId(c.id),
    onDeleteCollection: deleteCollection,
    onDeleteRequest: deleteRequest,
    onRenameRequest: renameRequest,
    onMoveRequest: moveRequest,
    onNewRequestIn: newRequestIn,
    onNewFolder: newFolder,
    onRenameFolder: renameFolder,
    onDeleteFolder: deleteFolder,
    onImport: importFile,
    onExport: exportAll,
    onOpenFlow: openFlow,
    onNewFlow: newFlow,
    onMoveFlow: moveFlow,
    onMoveFlowFolder: moveFlowFolder,
    onNewFlowFolder: newFlowFolder,
    onRenameFlowFolder: renameFlowFolder,
    onDeleteFlowFolder: deleteFlowFolder,
  });

  const settingsCol = collections.find((c) => c.id === settingsColId) || null;
  const shell = isShellTest(request);

  return (
    <div className="app">
      <Sidebar
        envBar={envBar}
        collections={collections}
        activeRequestId={request.id}
        flows={flows}
        flowFolders={flowFolders}
        activeFlowId={flow ? flow.id : null}
        {...side}
      />

      <main className="main">
        {flow ? (
          <FlowPanel
            environments={environments}
            activeEnvId={flowEnvId}
            flow={flow}
            collections={collections}
            onChange={fd.edit}
            onRun={() => fd.runFlow(flowEnvId)}
            onRunStep={(stepId) => fd.runStep(stepId, flowEnvId)}
            onClearReport={() => fd.forgetReports([flow.id])}
            onDelete={deleteFlow}
            running={fd.running}
            runningStep={fd.runningStep}
            report={fd.report}
            environmentName={
              (environments.find((e) => e.id === flowEnvId) || {}).name || null
            }
            envVars={envVarsOf(environments, flowEnvId)}
          />
        ) : shell ? (
          <ShellTestPanel
            environments={environments}
            activeEnvId={activeEnvId}
            test={request}
            onChange={req.edit}
            onRun={req.send}
            onCancel={req.cancelSend}
            onSave={() => setSaveModalOpen(true)}
            running={req.sending}
            saveStatus={req.status}
            vars={previewVars}
            envVars={envVars}
            resolvedCommand={(() => {
              const resolved = substitute(request.command || '', previewVars);
              return resolved !== (request.command || '') ? resolved : '';
            })()}
            crumb={crumb}
          />
        ) : (
          <RequestPanel
            environments={environments}
            activeEnvId={activeEnvId}
            request={request}
            onChange={req.edit}
            onSend={req.send}
            onCancel={req.cancelSend}
            onSave={() => setSaveModalOpen(true)}
            sending={req.sending}
            onUploadFile={api.uploadFile}
            saveStatus={req.status}
            vars={previewVars}
            envVars={envVars}
            // Show {{dy_url}} as a valid token whose tooltip reveals its full
            // expansion, with {{base_url}} resolved to its actual value too.
            urlVars={{
              ...previewVars,
              dy_url: substitute(dyUrl(col ? col.folders || [] : [], request.folderId), previewVars),
            }}
            resolvedUrl={(() => {
              // Built by the server's own functions, query params and all, so it
              // is the url a flow step with this request shows too.
              const composed = composeUrl(col ? col.folders || [] : [], request.folderId, request.url) || '';
              const full = buildUrl(composed, request.params, previewVars);
              return full !== request.url ? full : null;
            })()}
            auth={describeAuth(col, request, previewVars)}
            collectionName={col ? col.name : undefined}
            crumb={crumb}
          />
        )}
        {!flow && (
          <ResponsePanel
            response={req.response}
            error={req.error}
            sending={req.sending}
            scriptResult={req.scriptResult}
            busyText={shell ? 'Running the command…' : undefined}
            emptyText={shell ? 'What the command printed will appear here' : undefined}
            onClear={req.clearResponse}
          />
        )}
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
            onClose={() => setSettingsColId(null)}
          />
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

      {notice && (
        <div className="app-notice" role="alert">
          <span>⚠ {notice}</span>
          <button className="mini-text" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
