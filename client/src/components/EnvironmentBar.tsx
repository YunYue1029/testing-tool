import React, { useState, useMemo, useRef } from 'react';
import KeyValueEditor from './KeyValueEditor';
import { IconPencil, IconClose } from './Icons';
import HelpTip from './HelpTip';
import useAutoSave from '../useAutoSave';
import { DEFAULT_BASE_URL, baseUrlVar } from '../util';
import type { Collection, Environment, Row } from '../types.ts';

// The environment being edited, as the dialog holds it: rows rather than a
// map, so an unchecked key keeps its value and its place.
interface EnvDraft {
  id: string | null;
  name: string;
  rows: Row[];
  isDefault: boolean;
}

interface EnvironmentBarProps {
  environments: Environment[];
  activeEnvId: string | null;
  onSelect: (id: string | null) => void;
  // Answers with the stored environment: a new one is only new until its first
  // auto-save, and what it saves next depends on the id it got back.
  onSaveEnv: (env: Partial<Environment>) => Promise<Environment>;
  onDeleteEnv: (id: string) => Promise<void> | void;
  collections: Collection[];
  collection: Collection | null | undefined;
  envBaseUrl: string;
  onSaveBaseUrl: (value: string) => Promise<void> | void;
  savedBaseUrls: string[];
  onSaveBaseUrls: (list: string[]) => Promise<void> | void;
}

// Two dropdowns: the active environment, and the open collection's base_url —
// the layer that actually wins at send time, kept here because it gets switched
// often (one service/container to another). Each has an edit button next to it;
// adding stays inside the menu, being the rarer action.
export default function EnvironmentBar({
  environments, activeEnvId, onSelect, onSaveEnv, onDeleteEnv,
  collections, collection, envBaseUrl, onSaveBaseUrl, savedBaseUrls, onSaveBaseUrls,
}: EnvironmentBarProps) {
  const [editing, setEditing] = useState<EnvDraft | null>(null); // env being edited
  const [managing, setManaging] = useState<string[] | null>(null); // draft of the saved base-URL list

  // Every collection's url variable, listed empty — the server declares them
  // too, but the draft is what the next auto-save writes back, so they have to
  // be in it.
  function openNew() {
    const urlVars = [...new Set(collections.map((c) => baseUrlVar(c.baseUrl)).filter(Boolean))];
    const rows = urlVars.map((key) => ({ key: key as string, value: '', enabled: true }));
    rows.push({ key: '', value: '', enabled: true });
    setEditing({ id: null, name: 'New Environment', rows, isDefault: false });
  }

  function openEdit(env: Environment) {
    const off = env.disabled || [];
    const rows = Object.entries(env.variables || {})
      .map(([key, value]) => ({ key, value, enabled: !off.includes(key) }));
    rows.push({ key: '', value: '', enabled: true });
    setEditing({ id: env.id, name: env.name, rows, isDefault: !!env.isDefault });
  }

  // Written as the variables are edited, not when a button says so: an
  // environment is edited by opening it, changing a value and going back to
  // what you were doing, and a Save between those two is a step to forget.
  const autoSave = useAutoSave(editing, async (draft: EnvDraft) => {
    // Unchecked rows are kept (value preserved) but listed as disabled so
    // they don't participate in {{var}} substitution.
    const variables: Record<string, string> = {};
    const disabled: string[] = [];
    for (const r of draft.rows) {
      if (!r.key) continue;
      variables[r.key] = r.value;
      if (r.enabled === false) disabled.push(r.key);
    }
    const saved = await onSaveEnv({
      id: draft.id || undefined, name: draft.name || 'Untitled', variables, disabled,
      isDefault: draft.isDefault,
    });
    // The draft stops being new here, or the next keystroke would create a
    // second environment instead of writing this one again. The id is the
    // save's own doing, so it is not an edit to save.
    if (!draft.id) {
      autoSaveRef.current.skipNext();
      setEditing((d) => (d && !d.id ? { ...d, id: saved.id } : d));
    }
  });
  // The editor's own auto-save, reachable from inside the save it runs.
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;

  async function closeEditor() {
    // Whatever was typed in the last 600ms is still only here.
    await autoSave.flush();
    setEditing(null);
  }

  const activeEnv = environments.find((e) => e.id === activeEnvId);

  function changeEnv(value: string) {
    // The action entry never becomes the select's value — it is controlled by
    // activeEnvId, so it snaps back to the real selection on re-render.
    if (value === '__new') { openNew(); return; }
    onSelect(value || null);
  }

  // ---- Collection base_url ----
  const colId = collection ? collection.id : null;
  const colBaseUrl = (collection && collection.baseUrl) || '';

  // The saved pick-list, plus every base URL actually in play. The latter must
  // be included or a collection's current URL could be missing from its own
  // dropdown just because nobody saved it to the list.
  const knownBaseUrls = useMemo(() => {
    const list: string[] = [];
    const add = (v: string | null | undefined) => {
      const s = (v || '').trim();
      if (s && !list.includes(s)) list.push(s);
    };
    (savedBaseUrls || []).forEach(add);
    (collections || []).forEach((c) => add(c.baseUrl));
    (environments || []).forEach((e) => add((e.variables || {}).base_url));
    add(DEFAULT_BASE_URL);
    return list;
  }, [savedBaseUrls, collections, environments]);

  async function persistBaseUrlList(list: string[]) {
    try {
      await onSaveBaseUrls(list);
    } catch (e) {
      alert(`Failed to save the base URL list: ${(e as Error).message}`);
      throw e;
    }
  }

  async function persistBaseUrl(value: string) {
    try {
      await onSaveBaseUrl(value);
    } catch (e) {
      alert(`Failed to save base URL: ${(e as Error).message}`);
    }
  }

  function changeBaseUrl(value: string) {
    if (value === '__manage') {
      setManaging([...(savedBaseUrls || []), '']);
      return;
    }
    if (value === '__new') {
      const next = prompt('Add a base URL — saved to the list and applied to this collection:', 'http://');
      if (next == null || !next.trim()) return;
      const url = next.trim();
      // Saved to the list first, so the entry survives this collection later
      // pointing somewhere else.
      persistBaseUrlList([...(savedBaseUrls || []), url]).then(() => persistBaseUrl(url), () => {});
      return;
    }
    persistBaseUrl(value);
  }

  function editBaseUrl() {
    const next = prompt(`Base URL for collection "${collection!.name}":`, colBaseUrl || envBaseUrl);
    if (next == null) return;
    persistBaseUrl(next.trim());
  }

  return (
    <div className="env-bar">
      <span className="env-label">Env:</span>
      <select value={activeEnvId || ''} onChange={(e) => changeEnv(e.target.value)}>
        <option value="">No Environment</option>
        {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        <optgroup label="Manage">
          <option value="__new">+ New environment…</option>
        </optgroup>
      </select>
      <button
        className="mini bar-act"
        disabled={!activeEnv}
        title={activeEnv ? `Edit "${activeEnv.name}" variables` : 'Select an environment to edit it'}
        onClick={() => openEdit(activeEnv!)}
      ><IconPencil /></button>

      <span className="env-label base-label">Base&nbsp;URL:</span>
      <select
        className="base-select"
        value={colBaseUrl}
        disabled={!colId}
        title={colId
          ? `Base URL for collection "${collection!.name}" — overrides {{base_url}} for its requests`
          : 'Open a request from a collection to set its base URL'}
        onChange={(e) => changeBaseUrl(e.target.value)}
      >
        <option value="">Inherit: {envBaseUrl}</option>
        {knownBaseUrls.map((u) => <option key={u} value={u}>{u}</option>)}
        {colId && (
          <optgroup label="Manage">
            <option value="__new">+ Add base URL…</option>
            <option value="__manage">Manage saved URLs…</option>
          </optgroup>
        )}
      </select>
      <button
        className="mini bar-act"
        disabled={!colId}
        title={colId ? 'Edit this base URL' : 'Open a request from a collection to set its base URL'}
        onClick={editBaseUrl}
      ><IconPencil /></button>

      {managing && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>
              Saved base URLs
              <HelpTip>
                The list offered in the Base URL dropdown. Editing an entry here only
                changes the list — a collection already pointing at the old value keeps it.
              </HelpTip>
            </h3>
            <table className="kv">
              <tbody>
                {managing.map((url, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        value={url}
                        placeholder="http://localhost:8000"
                        onChange={(e) => {
                          let next = managing.map((u, idx) => (idx === i ? e.target.value : u));
                          if (next[next.length - 1].trim()) next = [...next, ''];
                          setManaging(next);
                        }}
                      />
                    </td>
                    <td className="kv-del">
                      {url.trim() && (
                        <button
                          className="mini danger"
                          title="Remove from the list"
                          onClick={() => setManaging(managing.filter((_, idx) => idx !== i))}
                        ><IconClose /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="modal-actions">
              <span className="spacer" />
              <button className="btn-secondary" onClick={() => setManaging(null)}>Cancel</button>
              <button
                className="btn-send"
                onClick={async () => {
                  try {
                    await persistBaseUrlList(managing);
                    setManaging(null);
                  } catch { /* the alert already explained it; keep the draft open */ }
                }}
              >Save</button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        // A backdrop click closes it, which it could not while closing meant
        // discarding: the variables are already saved by the time it happens.
        <div
          className="modal-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) closeEditor(); }}
        >
          <div className="modal">
            <h3>
              {editing.id ? 'Edit' : 'New'} Environment
              <HelpTip>Reference these anywhere with <code>{'{{name}}'}</code>.</HelpTip>
            </h3>
            <input
              className="modal-name"
              value={editing.name}
              placeholder="Environment name"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') closeEditor(); }}
            />
            {/* Which environment a request's or flow's vars read `value` from —
                the column every other environment falls back to. */}
            <label className="env-default">
              <input
                type="checkbox"
                checked={editing.isDefault}
                onChange={(e) => setEditing({ ...editing, isDefault: e.target.checked })}
              /> Default environment — request and flow vars use its values wherever another
              environment has none of its own
            </label>
            <KeyValueEditor
              rows={editing.rows}
              onChange={(rows) => setEditing({ ...editing, rows })}
              keyPlaceholder="variable"
              valuePlaceholder="value"
            />
            <div className="modal-actions">
              {editing.id && (
                <button
                  className="btn-danger"
                  onClick={() => {
                    if (!confirm(`Delete environment "${editing.name}" and all its variables?`)) return;
                    onDeleteEnv(editing.id!);
                    setEditing(null);
                  }}
                >Delete</button>
              )}
              <span className="spacer" />
              {autoSave.status && (
                <span className={`save-status ${autoSave.status === 'Save failed' ? 'err' : ''}`}>
                  {autoSave.status}
                </span>
              )}
              <button className="btn-send" onClick={closeEditor}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
