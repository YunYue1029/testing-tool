import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from './api.ts';
import type { Collection, Environment, Flow, Folder } from './types.ts';

// What a refresh read, handed back for whoever has to look at it before the
// state setters below have landed.
export interface Loaded {
  collections: Collection[];
  flows: Flow[];
}

export interface Workspace {
  collections: Collection[];
  environments: Environment[];
  flows: Flow[];
  flowFolders: Folder[];
  setCollections: Dispatch<SetStateAction<Collection[]>>;
  setEnvironments: Dispatch<SetStateAction<Environment[]>>;
  setFlows: Dispatch<SetStateAction<Flow[]>>;
  setFlowFolders: Dispatch<SetStateAction<Folder[]>>;
  // A write answers with the record as the server now holds it; these put
  // that copy in its list, or add it when it is new, so nothing has to be
  // read back after writing.
  putCollection: (c: Collection) => void;
  putEnvironment: (e: Environment) => void;
  putFlow: (f: Flow) => void;
  refresh: () => Promise<Loaded>;
}

const upsert = <T extends { id: string }>(list: T[], item: T): T[] =>
  (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]);

// The four lists this tab shows, and keeping them current with a server that
// this tab is not the only editor of: Claude writes through MCP into the same
// backend, and until now a screen loaded before that simply stayed wrong. The
// server counts its writes, so ask for the count every few seconds and pull
// the lists in when it moves. `onChanged` runs after such a reload with what
// arrived, so the open request or flow can be brought up to date too;
// `onLoadError` is told when the first load fails.
export default function useWorkspace(
  onChanged: (loaded: Loaded) => void,
  onLoadError: (message: string) => void,
): Workspace {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [flowFolders, setFlowFolders] = useState<Folder[]>([]);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;

  // Which revision of the server's data the screen was built from — the poll
  // further down compares against this to know whether it is out of date.
  const seenRev = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    // Read the counter before the lists, never after: a write landing in
    // between then leaves it looking stale and costs one needless refresh,
    // where the other order would record a revision we never actually loaded
    // and lose that change for good.
    const at = await api.getRev().catch(() => null);
    const [cols, envs, fls, flowDirs] = await Promise.all([
      api.listCollections(), api.listEnvironments(), api.listFlows(), api.listFlowFolders(),
    ]);
    if (at) seenRev.current = `${at.startedAt}:${at.rev}`;
    setCollections(cols);
    setEnvironments(envs);
    setFlows(fls);
    setFlowFolders(flowDirs);
    // Handed back for the poll below, which has to inspect what just arrived —
    // the state setters above have not landed yet at that point.
    return { collections: cols, flows: fls };
  }, []);

  useEffect(() => {
    refresh().catch((e) => onLoadErrorRef.current((e as Error).message));
  }, [refresh]);

  // Every response says where the server's count stands, so this tab's own
  // writes need not send the poll reloading everything: a write that moved
  // the count by exactly one was ours, and the mark moves with it. Anything
  // else — a jump of two, because someone else wrote in between; a server
  // that restarted and counts from a new epoch — leaves the mark where it
  // was, so the next poll notices and reloads. A read never moves it: a list
  // fetched for one purpose says nothing about the rest of the workspace, so
  // the count it reports may already include a change this tab has not seen.
  useEffect(() => api.onRev((header, method) => {
    const seen = seenRev.current;
    if (seen === null || method === 'GET') return;
    const [startedAt, rev] = header.split(':');
    const [seenStart, seenNo] = seen.split(':');
    if (startedAt !== seenStart) return;
    if (Number(rev) === Number(seenNo) + 1) seenRev.current = header;
  }), []);

  // The poll sleeps while the tab is hidden and checks the moment it comes
  // back — which is exactly when you return to the browser after telling
  // Claude to change something.
  useEffect(() => {
    let busy = false;

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
        onChangedRef.current(await refresh());
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

  return {
    collections, environments, flows, flowFolders,
    setCollections, setEnvironments, setFlows, setFlowFolders,
    putCollection: (c) => setCollections((cols) => upsert(cols, c)),
    putEnvironment: (e) => setEnvironments((envs) => upsert(envs, e)),
    putFlow: (f) => setFlows((fs) => upsert(fs, f)),
    refresh,
  };
}
