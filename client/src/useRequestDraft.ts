import { useRef, useState } from 'react';
import { api } from './api.ts';
import useAutoSave from './useAutoSave.ts';
import type { SaveStatus } from './useAutoSave.ts';
import { newRequest, normalizeRequest } from './util.ts';
import type { Collection, Environment, RunResponse, SavedRequest, ScriptReport } from './types.ts';

interface Deps {
  activeEnvId: string | null;
  putCollection: (c: Collection) => void;
  setEnvironments: (envs: Environment[]) => void;
}

// A new draft, or one worked out from the current one.
type Next = SavedRequest | ((cur: SavedRequest) => SavedRequest);

export interface RequestDraft {
  request: SavedRequest;
  collectionId: string | null; // where the open request lives; null while filed nowhere
  // Blank while the request is filed nowhere: there is nothing to save it to.
  status: SaveStatus;
  // Edits the server has not accepted yet. The poll refuses to replace the
  // open request while this is true, so an update arriving from elsewhere
  // can never overwrite something half-typed.
  dirty: boolean;
  edit: (next: Next) => void;
  // A change already written through its own endpoint (a rename, a move).
  patch: (next: Next) => void;
  // Show another request, filed under `collectionId`. Not an edit; what was
  // pending for the one before is flushed first, so the last keystroke
  // still lands. `replace` is the same without the flush, for a caller whose
  // own write already carried the pending edits.
  open: (collectionId: string | null, r: SavedRequest, status: SaveStatus) => Promise<void>;
  replace: (collectionId: string | null, r: SavedRequest, status: SaveStatus) => void;
  // Keep the content on screen but stop writing it anywhere: the request, or
  // its collection, was deleted, and auto-save would only add it back.
  detach: () => void;
  flush: () => Promise<void>;
  // The server's copy arrived: take it, unless edits here are waiting.
  takeUpdate: (collections: Collection[]) => void;

  response: RunResponse | null;
  error: string | null;
  sending: boolean;
  scriptResult: ScriptReport | null;
  send: () => Promise<void>;
  cancelSend: () => void;
  clearResponse: () => void;
}

// The request in the panel: what it holds, where it is filed, its auto-save,
// and the last thing sending it got back.
export default function useRequestDraft({ activeEnvId, putCollection, setEnvironments }: Deps): RequestDraft {
  const [collectionId, setCollectionId] = useState<string | null>(null);
  // Read at write time, alongside the draft, so a write for one request can
  // never land in the collection of the next one opened.
  const collectionIdRef = useRef(collectionId);

  const autoSave = useAutoSave<SavedRequest>(newRequest, async (r) => {
    const colId = collectionIdRef.current;
    if (!colId) return;
    // Only this request travels: the server merges it into whatever the
    // collection currently holds, so a folder renamed or a request added
    // since we last loaded survives our save.
    putCollection(await api.putRequest(colId, r));
  });
  // Never null: the panel always shows some request, filed or not.
  const request = autoSave.draft!;
  const requestRef = useRef(request);
  requestRef.current = request;

  const [response, setResponse] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [scriptResult, setScriptResult] = useState<ScriptReport | null>(null); // { saved } | { error }
  // Held while a request is in flight so Send can turn into Cancel.
  const sendAbort = useRef<AbortController | null>(null);

  // The draft is never null, so an updater here need not say what it would
  // do with nothing.
  const lift = (next: Next) => (typeof next === 'function' ? (cur: SavedRequest | null) => next(cur!) : next);

  function replace(colId: string | null, r: SavedRequest, status: SaveStatus) {
    collectionIdRef.current = colId;
    setCollectionId(colId);
    autoSave.replace(r, status);
  }

  // The response panel's Clear: what the last send left, gone.
  function clearResponse() {
    setResponse(null);
    setError(null);
    setScriptResult(null);
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

  return {
    request,
    collectionId,
    status: collectionId ? autoSave.status : '',
    get dirty() { return autoSave.dirty; },
    edit: (next) => autoSave.edit(lift(next)),
    patch: (next) => autoSave.patch(lift(next)),
    replace,
    async open(colId, r, status) {
      await autoSave.flush();
      replace(colId, r, status);
      clearResponse();
    },
    detach() {
      replace(null, requestRef.current, '');
    },
    flush: autoSave.flush,
    takeUpdate(collections) {
      const col = collections.find((c) => c.id === collectionIdRef.current);
      const mine = requestRef.current;
      const theirs = col && (col.requests || []).find((r) => r.id === mine.id);
      // Take the server's copy only when nothing here is waiting to be saved:
      // showing an update a few seconds late is a far smaller sin than
      // typing over someone's unsaved edit.
      if (!theirs || autoSave.dirty) return;
      const next = normalizeRequest(theirs);
      if (JSON.stringify(next) !== JSON.stringify(mine)) autoSave.replace(next, 'Updated');
    },
    response, error, sending, scriptResult,
    send,
    cancelSend: () => { if (sendAbort.current) sendAbort.current.abort(); },
    clearResponse,
  };
}
