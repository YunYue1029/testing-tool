import React, { useState, useRef, useEffect, useMemo } from 'react';
import { authHeader, folderWithDescendants } from '../util';
import { searchWorkspace, highlightParts } from '../search';
import {
  IconPlus, IconClose, IconPencil, IconFolder, IconCollection, IconImport, IconExport,
  IconCollapse, IconSearch, IconTerminal,
} from './Icons';

import type { Collection, Flow, Folder, SavedRequest, SearchHit } from '../types.ts';

interface SidebarProps {
  collections: Collection[];
  activeRequestId: string | null;
  onNewRequest: () => void;
  onNewShellTest: () => void;
  onNewShellTestIn: (col: Collection, folderId: string | null) => void;
  onOpenRequest: (col: Collection, r: SavedRequest) => void;
  onNewCollection: () => void;
  onOpenCollectionSettings: (col: Collection) => void;
  onDeleteCollection: (col: Collection) => void;
  onDeleteRequest: (col: Collection, r: SavedRequest) => void;
  onRenameRequest: (col: Collection, r: SavedRequest) => void;
  onMoveRequest: (colId: string, requestId: string, folderId: string | null) => void;
  onNewRequestIn: (col: Collection, folderId?: string | null) => void;
  onNewFolder: (col: Collection, parentId: string | null) => void;
  onRenameFolder: (col: Collection, folder: Folder) => void;
  onDeleteFolder: (col: Collection, folder: Folder) => void;
  onImport: (data: Record<string, unknown>) => void;
  onExport: () => void;
  flows: Flow[];
  flowFolders: Folder[];
  activeFlowId: string | null;
  onOpenFlow: (flow: Flow) => void;
  onNewFlow: (folderId?: string | null) => void;
  onMoveFlow: (flowId: string, folderId: string | null) => void;
  onMoveFlowFolder: (folderId: string, parentId: string | null) => void;
  onNewFlowFolder: (parentId: string | null) => void;
  onRenameFlowFolder: (folder: Folder) => void;
  onDeleteFlowFolder: (folder: Folder) => void;
}

// A drag carrying a flow says so in its own type, so a drop target can tell one
// from a file dragged in off the desktop before it lights up.
const FLOW_DRAG_TYPE = 'application/x-testing-tool-flow';
const REQUEST_DRAG_TYPE = 'application/x-testing-tool-request';
// A flow folder moves the same way its flows do, so it travels as its own type:
// a head that would take a flow has to be able to refuse a folder that would
// land inside itself.
const FLOW_FOLDER_DRAG_TYPE = 'application/x-testing-tool-flow-folder';

// How long a collapsed folder has to be hovered, mid-drag, before it opens.
// Long enough that merely crossing one on the way somewhere else leaves it
// shut, short enough that stopping on it feels like it answered.
const SPRING_DELAY = 600;
// The band at each end of the tree that scrolls while a drag hovers in it, and
// how far one frame moves. 8px a frame is about a row every three frames — fast
// enough to cross a long tree, slow enough to stop on the right folder.
const SCROLL_EDGE = 52;
const SCROLL_STEP = 8;

// What a row shows of where a request points: its url, or for a shell test
// the command, which is the only thing it has.
function reqWhat(r: SavedRequest): string {
  return r.kind === 'shell' ? (r.command || '') : (r.url || '');
}

function MethodTag({ method }: { method: string }) {
  return <span className={`tag tag-${method}`}>{method}</span>;
}

// The text of a search result with the matched runs marked, so a row can be
// scanned for why it is there.
function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((p, i) => (
        p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>
      ))}
    </>
  );
}

export default function Sidebar({
  collections, activeRequestId,
  onNewRequest, onNewShellTest, onNewShellTestIn, onOpenRequest,
  onNewCollection, onOpenCollectionSettings, onDeleteCollection, onDeleteRequest,
  onRenameRequest, onMoveRequest, onNewRequestIn, onNewFolder, onRenameFolder, onDeleteFolder,
  onImport, onExport,
  flows, flowFolders, activeFlowId, onOpenFlow, onNewFlow, onMoveFlow, onMoveFlowFolder,
  onNewFlowFolder, onRenameFlowFolder, onDeleteFlowFolder,
}: SidebarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return (JSON.parse(localStorage.getItem('collapsedCols') || 'null') || {}) as Record<string, boolean>;
    } catch { return {} as Record<string, boolean>; }
  });

  // ---- Search ----
  // While a query is typed the tree is replaced by a flat, ranked list: the
  // whole point is to find a request without knowing which folder it sits in.
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0); // which result ↑/↓ has selected
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const results = useMemo(
    () => searchWorkspace({ collections, flows, flowFolders }, query),
    [collections, flows, flowFolders, query]
  );
  const searching = query.trim() !== '';

  // A fresh query starts at the top; without this Enter could open whatever the
  // old cursor position now points at.
  useEffect(() => { setCursor(0); }, [query]);

  // Keep the selected row on screen when arrowing past the fold.
  useEffect(() => {
    const el = resultsRef.current && resultsRef.current.children[cursor];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function openResult(r: SearchHit) {
    if (!r) return;
    if (r.kind === 'flow') onOpenFlow(r.flow!);
    else onOpenRequest(r.collection!, r.request!);
    // The query stays: after opening one match you usually want the next.
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((c) => (c + step + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openResult(results[cursor]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else searchRef.current?.blur();
    }
  }

  // Collapsed by default: only an explicit `false` counts as expanded.
  const isCollapsed = (id: string) => collapsed[id] !== false;
  // The two section headers are the opposite way round: a collection or folder
  // starts closed so a big tree stays scannable, but a section that starts
  // closed just hides the whole sidebar until you find the caret.
  const isSectionCollapsed = (id: string) => collapsed[id] === true;

  function persistCollapsed(next: Record<string, boolean>) {
    setCollapsed(next);
    localStorage.setItem('collapsedCols', JSON.stringify(next));
  }

  // Read through a ref rather than the render's copy: a spring-open fires from
  // a timer armed some folders ago, and merging into what `collapsed` was then
  // would shut whatever opened in between.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  function setCollapsedFor(id: string, value: boolean) {
    persistCollapsed({ ...collapsedRef.current, [id]: value });
  }

  // ---- Getting to a folder you cannot see ----
  // Two things a tree this size needs before dragging into it is realistic: a
  // closed folder opens if you hover it, and the tree scrolls if you hover its
  // edge. Both belong to the drag, so both are undone the moment it ends.
  const spring = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  function cancelSpring() {
    if (!spring.current) return;
    clearTimeout(spring.current.timer);
    spring.current = null;
  }

  // Called on every dragover, which repeats while the pointer sits still: the
  // timer is armed by the first one and left alone by the rest.
  function armSpring(id: string | null) {
    if (!id || !isCollapsed(id)) { cancelSpring(); return; }
    if (spring.current && spring.current.id === id) return;
    cancelSpring();
    spring.current = {
      id,
      timer: setTimeout(() => { spring.current = null; setCollapsedFor(id, false); }, SPRING_DELAY),
    };
  }

  // Driven by the frame clock rather than a timer: the step is a distance per
  // frame, and a drag only happens in a window the user is looking at.
  const autoScroll = useRef<{ raf: number; dy: number } | null>(null);

  function stopAutoScroll() {
    if (!autoScroll.current) return;
    cancelAnimationFrame(autoScroll.current.raf);
    autoScroll.current = null;
  }

  function autoScrollAt(clientY: number) {
    const el = scrollRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    let dy = 0;
    if (clientY < box.top + SCROLL_EDGE) dy = -SCROLL_STEP;
    else if (clientY > box.bottom - SCROLL_EDGE) dy = SCROLL_STEP;
    if (!dy) { stopAutoScroll(); return; }
    // Already scrolling: only the direction can have changed. Starting a second
    // loop would scroll twice as fast for the rest of the drag.
    if (autoScroll.current) { autoScroll.current.dy = dy; return; }
    const state = { dy, raf: 0 };
    const step = () => {
      el.scrollTop += state.dy;
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
    autoScroll.current = state;
  }

  // One of ours, rather than a file dragged in off the desktop — asked of the
  // scroller, which sees every drag that crosses the tree at all.
  const dragging = (e: React.DragEvent) => e.dataTransfer.types.some(
    (t) => t === FLOW_DRAG_TYPE || t === REQUEST_DRAG_TYPE || t === FLOW_FOLDER_DRAG_TYPE,
  );

  // Everything a drag turned on, off — for the drop, and for the drag that
  // ended over nothing, which never reaches a drop handler at all.
  function endDrag() {
    cancelSpring();
    stopAutoScroll();
  }

  // A drag can also end by this whole tree going away (a search query replaces
  // it), which fires no drag event anywhere.
  useEffect(() => endDrag, []);

  const flowsIn = (folderId: string | null) => (flows || [])
    .filter((f) => (f.folderId || null) === folderId)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // ---- Filing a flow by dragging it ----
  // Which folder a flow sits in is a fact about the tree, so it is answered
  // here, where the tree is: drag the flow onto the folder it belongs to, or
  // onto the "Flows" header to take it back out to the root.
  const [dragFlowId, setDragFlowId] = useState<string | null>(null); // the flow under the cursor
  const [dropInto, setDropInto] = useState<string | null | undefined>(undefined); // folder id, null = root
  // The folder being dragged, if it is a folder and not a flow. In a ref as
  // well as state because a dragover has to know, and getData stays sealed
  // until the drop: whether a head may take this folder is a question about
  // which folder is moving.
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);
  const dragFolderRef = useRef<string | null>(null);

  function flowDropProps(folderId: string | null) {
    // What this head takes. A flow, always. A folder only if that would not
    // file it inside itself or its own subtree — which would cut the branch
    // off the tree, leaving it in the file and reachable from nothing.
    const takes = (e: React.DragEvent): boolean => {
      // getData is sealed until the drop, so a dragover has only the type to
      // go on — which also keeps files dragged in from the desktop out.
      if (e.dataTransfer.types.includes(FLOW_DRAG_TYPE)) return true;
      if (!e.dataTransfer.types.includes(FLOW_FOLDER_DRAG_TYPE)) return false;
      const moving = dragFolderRef.current;
      if (!moving || moving === folderId) return false;
      return !folderWithDescendants(flowFolders, moving).includes(folderId as string);
    };
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!takes(e)) return;
        e.preventDefault(); // the default answer to "may I drop here" is no
        e.dataTransfer.dropEffect = 'move';
        setDropInto(folderId);
        armSpring(folderId);
      },
      onDragLeave: (e: React.DragEvent) => {
        // Crossing onto a child fires leave on the parent, where the pointer
        // still is; only a leave that really left counts.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        cancelSpring();
        setDropInto((cur) => (cur === folderId ? undefined : cur));
      },
      onDrop: (e: React.DragEvent) => {
        if (!takes(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const movingFolder = dragFolderRef.current
          || e.dataTransfer.getData(FLOW_FOLDER_DRAG_TYPE);
        const movingFlow = dragFlowId || e.dataTransfer.getData(FLOW_DRAG_TYPE);
        dragFolderRef.current = null;
        setDragFolderId(null);
        setDropInto(undefined);
        setDragFlowId(null);
        endDrag();
        // Dropping into a closed folder would otherwise look like the thing
        // dropped had vanished.
        if (folderId) setCollapsedFor(folderId, false);
        if (movingFolder) onMoveFlowFolder(movingFolder, folderId);
        else if (movingFlow) onMoveFlow(movingFlow, folderId);
      },
    };
  }

  // ---- The same gesture in the Tests tree ----
  // A request is filed by dragging it onto a folder of its own collection, and
  // only its own: a request's folder path is its route — {{dy_url}} expands to
  // it — so a folder in another collection means a different route under a
  // different base URL. That is a move to make deliberately in the save dialog,
  // not one to land two pixels off a drag.
  const [dragReq, setDragReq] = useState<{ colId: string; id: string } | null>(null);
  // The same thing in a ref, because a drop target reads it from inside an
  // event: the first dragover can arrive before React has committed the
  // dragstart, and a highlight that depends on that would come up a frame late.
  const dragReqRef = useRef<{ colId: string; id: string } | null>(null);

  function reqDropProps(colId: string, folderId: string | null) {
    const key = folderId || colId; // a collection head stands for its own root
    // The type says it is one of ours; the collection has to match as well, and
    // only the drag in flight knows where it started.
    const takes = (e: React.DragEvent) => e.dataTransfer.types.includes(REQUEST_DRAG_TYPE)
      && dragReqRef.current && dragReqRef.current.colId === colId;
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!takes(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropInto(key);
        armSpring(folderId);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        cancelSpring();
        setDropInto((cur) => (cur === key ? undefined : cur));
      },
      onDrop: (e: React.DragEvent) => {
        if (!takes(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const moved = dragReqRef.current;
        dragReqRef.current = null;
        setDropInto(undefined);
        setDragReq(null);
        endDrag();
        if (folderId) setCollapsedFor(folderId, false);
        onMoveRequest(colId, moved!.id, folderId);
      },
    };
  }

  function collapseAll() {
    const next: Record<string, boolean> = {};
    collections.forEach((c) => { next[c.id] = true; });
    persistCollapsed(next);
  }

  function renderRequest(col: Collection, r: SavedRequest, depth: number) {
    return (
      <div
        key={r.id}
        className={`req-item ${activeRequestId === r.id ? 'active' : ''} ${dragReq && dragReq.id === r.id ? 'dragging' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onOpenRequest(col, r)}
        draggable
        onDragStart={(e) => {
          dragReqRef.current = { colId: col.id, id: r.id };
          setDragReq(dragReqRef.current);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(REQUEST_DRAG_TYPE, r.id);
          // Firefox refuses to start a drag that carries no text/plain.
          e.dataTransfer.setData('text/plain', r.name || reqWhat(r) || 'request');
        }}
        // Also on a drag that ended nowhere, or the row stays greyed out.
        onDragEnd={() => {
          dragReqRef.current = null; setDragReq(null); setDropInto(undefined); endDrag();
        }}
      >
        {/* SH rather than a method: a shell test sends nothing, and the tag is
            how a row says which of the two it is before you open it. */}
        <MethodTag method={r.kind === 'shell' ? 'SH' : r.method} />
        {/* Rename is the pencil button only — a stray double-click on the name
            used to pop the rename prompt while just opening the request. */}
        <span
          className="req-name"
          title={`${r.name || reqWhat(r) || 'Untitled'} — drag onto a folder of this collection to move it`}
        >
          {r.name || reqWhat(r) || 'Untitled'}
        </span>
        <button
          className="mini"
          title="Rename request"
          onClick={(e) => { e.stopPropagation(); onRenameRequest(col, r); }}
        ><IconPencil /></button>
        <button
          className="mini danger"
          title="Remove request"
          onClick={(e) => { e.stopPropagation(); onDeleteRequest(col, r); }}
        ><IconClose /></button>
      </div>
    );
  }

  function renderFlow(f: Flow, depth: number) {
    return (
      <div
        key={f.id}
        className={`req-item ${activeFlowId === f.id ? 'active' : ''} ${dragFlowId === f.id ? 'dragging' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onOpenFlow(f)}
        draggable
        onDragStart={(e) => {
          setDragFlowId(f.id);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(FLOW_DRAG_TYPE, f.id);
          // Firefox refuses to start a drag that carries no text/plain.
          e.dataTransfer.setData('text/plain', f.name || 'flow');
        }}
        // Also on a drag that ended nowhere, or the row stays greyed out.
        onDragEnd={() => { setDragFlowId(null); setDropInto(undefined); endDrag(); }}
      >
        <span className="tag tag-FLOW">FLOW</span>
        <span className="req-name" title={`${f.name} — drag onto a folder to file it`}>{f.name}</span>
      </div>
    );
  }

  // The flow tree, same shape as a collection's: folders first, then the flows
  // filed directly in this parent.
  function renderFlowChildren(parentId: string | null, depth: number) {
    const folders = (flowFolders || []).filter((f) => (f.parentId || null) === parentId);
    return (
      <>
        {folders.map((f) => (
          <div className="folder" key={f.id}>
            <div
              className={`folder-head ${dropInto === f.id ? 'drop-into' : ''} `
                + `${dragFolderId === f.id ? 'dragging' : ''}`}
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => setCollapsedFor(f.id, !isCollapsed(f.id))}
              // A folder is filed the same way the flows in it are: dragged.
              // It carries its whole subtree, so it is the head that moves and
              // nothing inside has to be touched.
              draggable
              onDragStart={(e) => {
                e.stopPropagation(); // a sub-folder moves itself, not its parent
                dragFolderRef.current = f.id;
                setDragFolderId(f.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData(FLOW_FOLDER_DRAG_TYPE, f.id);
                // Firefox refuses to start a drag that carries no text/plain.
                e.dataTransfer.setData('text/plain', f.name || 'folder');
              }}
              onDragEnd={() => {
                dragFolderRef.current = null;
                setDragFolderId(null);
                setDropInto(undefined);
                endDrag();
              }}
              {...flowDropProps(f.id)}
            >
              <span className={`caret ${isCollapsed(f.id) ? '' : 'open'}`}>▸</span>
              <span className="folder-icon"><IconFolder /></span>
              <span
                className="folder-name"
                title="Click to collapse/expand — drop a flow or folder here to file it, or drag it into another folder"
              >
                {f.name}
              </span>
              <button
                className="mini"
                title="Rename folder"
                onClick={(e) => { e.stopPropagation(); onRenameFlowFolder(f); }}
              ><IconPencil /></button>
              <button
                className="mini add"
                title="New flow in this folder"
                onClick={(e) => { e.stopPropagation(); setCollapsedFor(f.id, false); onNewFlow(f.id); }}
              ><IconPlus /></button>
              <button
                className="mini"
                title="New sub-folder"
                onClick={(e) => { e.stopPropagation(); setCollapsedFor(f.id, false); onNewFlowFolder(f.id); }}
              ><IconFolder /></button>
              <button
                className="mini danger"
                title="Delete folder"
                onClick={(e) => { e.stopPropagation(); onDeleteFlowFolder(f); }}
              ><IconClose /></button>
            </div>
            {!isCollapsed(f.id) && renderFlowChildren(f.id, depth + 1)}
          </div>
        ))}
        {flowsIn(parentId).map((f) => renderFlow(f, depth))}
      </>
    );
  }

  // Render the folders whose parent is `parentId`, then the requests directly
  // in that parent — recursively, so nested folders are supported.
  function renderChildren(col: Collection, parentId: string | null, depth: number) {
    const folders = (col.folders || []).filter((f) => (f.parentId || null) === parentId);
    const requests = (col.requests || []).filter((r) => (r.folderId || null) === parentId);
    return (
      <>
        {folders.map((f) => (
          <div className="folder" key={f.id}>
            <div
              className={`folder-head ${dropInto === f.id ? 'drop-into' : ''}`}
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => setCollapsedFor(f.id, !isCollapsed(f.id))}
              {...reqDropProps(col.id, f.id)}
            >
              <span className={`caret ${isCollapsed(f.id) ? '' : 'open'}`}>▸</span>
              <span className="folder-icon"><IconFolder /></span>
              <span
                className="folder-name"
                title="Click to collapse/expand — or drop a request here to move it into this folder"
              >
                {f.name}
              </span>
              <button
                className="mini"
                title="Rename folder"
                onClick={(e) => { e.stopPropagation(); onRenameFolder(col, f); }}
              ><IconPencil /></button>
              <button
                className="mini add"
                title="New request in this folder"
                onClick={(e) => { e.stopPropagation(); setCollapsedFor(f.id, false); onNewRequestIn(col, f.id); }}
              ><IconPlus /></button>
              <button
                className="mini"
                title="New shell test in this folder — a command, for what no response shows"
                onClick={(e) => { e.stopPropagation(); setCollapsedFor(f.id, false); onNewShellTestIn(col, f.id); }}
              ><IconTerminal /></button>
              <button
                className="mini"
                title="New sub-folder"
                onClick={(e) => { e.stopPropagation(); setCollapsedFor(f.id, false); onNewFolder(col, f.id); }}
              ><IconFolder /></button>
              <button
                className="mini danger"
                title="Delete folder"
                onClick={(e) => { e.stopPropagation(); onDeleteFolder(col, f); }}
              ><IconClose /></button>
            </div>
            {!isCollapsed(f.id) && renderChildren(col, f.id, depth + 1)}
          </div>
        ))}
        {requests.map((r) => renderRequest(col, r, depth))}
      </>
    );
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" />
        <span className="brand-name">Testing&nbsp;Tool</span>
        <button
          className="mini brand-act"
          title="Import — a testing-tool export file, or a Postman collection/environment (v2.x JSON)"
          onClick={() => fileRef.current?.click()}
        ><IconImport /></button>
        <button
          className="mini brand-act"
          title="Export to a file — pick tests, flows, environments or all of it, to import on another machine"
          onClick={onExport}
        ><IconExport /></button>
        <button className="mini brand-act" title="Collapse all collections" onClick={collapseAll}><IconCollapse /></button>
        {/* What the import button opens. Hidden, so it lives next to the button
            that reaches for it rather than wherever there was room. */}
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(await file.text());
            } catch {
              alert('That file is not valid JSON.');
              return;
            }
            onImport(data);
          }}
        />
      </div>

      {/* Outside the scroller: the box has to stay put while its results move. */}
      <div className="side-search">
        <span className="search-icon"><IconSearch /></span>
        <input
          ref={searchRef}
          value={query}
          placeholder="Search requests…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
        />
        {searching
          ? <button className="mini" title="Clear (Esc)" onClick={() => setQuery('')}><IconClose /></button>
          : <kbd>⌘K</kbd>}
      </div>

      {/* The tree scrolls itself while a drag hovers near either end: the row
          you picked up and the folder you want are rarely on screen together,
          and mid-drag there is no other way to reach the rest of the tree. */}
      <div
        className="side-scroll"
        ref={scrollRef}
        onDragOver={(e) => {
          // Read-only: preventDefault here would make the whole tree a drop
          // target, and the gaps between rows accept nothing.
          if (!dragging(e)) return;
          autoScrollAt(e.clientY);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          stopAutoScroll();
        }}
        onDrop={endDrag}
      >
        {searching && (
          <div className="search-results">
            <div className="search-head">
              <span>{results.length ? `${results.length} match${results.length > 1 ? 'es' : ''}` : 'No matches'}</span>
              <span>↑↓ · Enter</span>
            </div>
            <div ref={resultsRef}>
              {results.map((r, i) => (
                <div
                  key={r.key}
                  className={`req-item search-item ${i === cursor ? 'cursor' : ''} `
                    + `${(r.kind === 'request' ? activeRequestId === r.request!.id : activeFlowId === r.flow!.id)
                      ? 'active' : ''}`}
                  title={r.route}
                  onClick={() => { setCursor(i); openResult(r); }}
                >
                  <MethodTag method={r.method} />
                  <span className="search-text">
                    <span className="req-name"><Marked text={r.label} query={query} /></span>
                    {/* Where it lives, so two same-named endpoints stay apart. */}
                    <span className="res-where"><Marked text={r.detail} query={query} /></span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Two halves: the tests you send one at a time, and the flows that
            chain them. Each half is one collapsible section. */}
        {!searching && (
        <div className="collection">
          <div className="collection-head" onClick={() => setCollapsedFor('__apis', !isSectionCollapsed('__apis'))}>
            <span className={`caret ${isSectionCollapsed('__apis') ? '' : 'open'}`}>▸</span>
            <span className="collection-name">Tests</span>
            {/* Same pair as the Flows header: plus makes the thing itself, the
                icon beside it makes the container. A plain request belongs to
                no collection and is not saved anywhere yet, so it shows up in
                the panel rather than in the tree. */}
            <button
              className="mini add"
              title="New request — a blank one, not filed in any collection"
              onClick={(e) => { e.stopPropagation(); onNewRequest(); }}
            ><IconPlus /></button>
            <button
              className="mini"
              title="New shell test — a command instead of a request, filed nowhere yet"
              onClick={(e) => { e.stopPropagation(); onNewShellTest(); }}
            ><IconTerminal /></button>
            <button
              className="mini"
              title="New collection"
              onClick={(e) => { e.stopPropagation(); setCollapsedFor('__apis', false); onNewCollection(); }}
            ><IconCollection /></button>
          </div>
          {!isSectionCollapsed('__apis') && collections.length === 0 && <p className="hint">No collections yet.</p>}
          {!isSectionCollapsed('__apis') && collections.map((c) => (
          <div className="collection" key={c.id}>
            {/* The collection head is its own root: dropping a request here
                takes it out of whatever folder it was in. */}
            <div
              className={`collection-head ${dropInto === c.id ? 'drop-into' : ''}`}
              style={{ paddingLeft: 12 + 14 }}
              onClick={() => setCollapsedFor(c.id, !isCollapsed(c.id))}
              {...reqDropProps(c.id, null)}
            >
              <span className={`caret ${isCollapsed(c.id) ? '' : 'open'}`}>▸</span>
              <span
                className="collection-name"
                title="Click to collapse/expand — or drop a request here to move it to the collection root"
              >
                {c.name}
              </span>
              {/* One pencil for the whole collection — name, base URL and auth
                  live in the same modal, the way a flow step is edited. It
                  appears on hover like the row's other tools, whatever the
                  collection carries: lit on some rows and not others, it read
                  as a difference between them rather than as a setting. Whether
                  auth is set is in its title. */}
              <button
                className="mini"
                title={authHeader(c.auth)
                  ? 'Edit collection — name, base URL, auth (auth is set)'
                  : 'Edit collection — name, base URL, auth'}
                onClick={(e) => { e.stopPropagation(); onOpenCollectionSettings(c); }}
              ><IconPencil /></button>
              <button
                className="mini add"
                title="New request in this collection"
                onClick={(e) => { e.stopPropagation(); setCollapsedFor(c.id, false); onNewRequestIn(c); }}
              ><IconPlus /></button>
              <button
                className="mini"
                title="New shell test in this collection — a command, for what no response shows"
                onClick={(e) => { e.stopPropagation(); setCollapsedFor(c.id, false); onNewShellTestIn(c, null); }}
              ><IconTerminal /></button>
              <button
                className="mini"
                title="New folder in this collection"
                onClick={(e) => { e.stopPropagation(); setCollapsedFor(c.id, false); onNewFolder(c, null); }}
              ><IconFolder /></button>
              <button
                className="mini danger"
                title="Delete collection"
                onClick={(e) => { e.stopPropagation(); onDeleteCollection(c); }}
              ><IconClose /></button>
            </div>
            {!isCollapsed(c.id) && renderChildren(c, null, 2)}
          </div>
          ))}
        </div>
        )}

        {/* Flows chain saved requests (and shell steps) together, so they sit
            below the tests they draw their steps from. */}
        {!searching && (
        <div className="collection flows-section">
          {/* The header doubles as the root of the flow tree: dropping a flow
              or a folder here takes it back out of whatever folder it was in. */}
          <div
            className={`collection-head ${dropInto === null ? 'drop-into' : ''}`}
            onClick={() => setCollapsedFor('__flows', !isSectionCollapsed('__flows'))}
            {...flowDropProps(null)}
          >
            <span className={`caret ${isSectionCollapsed('__flows') ? '' : 'open'}`}>▸</span>
            <span
              className="collection-name"
              title="Click to collapse/expand — or drop a flow or folder here to move it to the top level"
            >
              Flows
            </span>
            <button
              className="mini add"
              title="New flow"
              onClick={(e) => { e.stopPropagation(); setCollapsedFor('__flows', false); onNewFlow(); }}
            ><IconPlus /></button>
            <button
              className="mini"
              title="New flow folder"
              onClick={(e) => { e.stopPropagation(); setCollapsedFor('__flows', false); onNewFlowFolder(null); }}
            ><IconFolder /></button>
          </div>
          {!isSectionCollapsed('__flows') && renderFlowChildren(null, 1)}
        </div>
        )}
      </div>
    </aside>
  );
}
