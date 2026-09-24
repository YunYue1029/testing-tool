import KeyValueEditor from './KeyValueEditor.tsx';
import { IconPencil } from './Icons.tsx';
import HelpTip from './HelpTip.tsx';
import useAutoSave from '../useAutoSave.ts';
import { baseUrlVar } from '../util.ts';
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
  // Read for the url variables a new environment starts out listing.
  collections: Collection[];
}

// The active environment, with an edit button next to it; adding stays inside
// the menu, being the rarer action. A collection's base url is set in its own
// settings — with every url written as an environment variable, there is
// nothing to switch here.
export default function EnvironmentBar({
  environments, activeEnvId, onSelect, onSaveEnv, onDeleteEnv, collections,
}: EnvironmentBarProps) {
  // Written as the variables are edited, not when a button says so: an
  // environment is edited by opening it, changing a value and going back to
  // what you were doing, and a Save between those two is a step to forget.
  // Null while no environment is being edited.
  const editor = useAutoSave<EnvDraft>(null, async (draft) => {
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
    if (!draft.id) editor.patch((d) => (d && !d.id ? { ...d, id: saved.id } : d));
  });
  const editing = editor.draft;

  // Every collection's url variable, listed empty — the server declares them
  // too, but the draft is what the next auto-save writes back, so they have to
  // be in it.
  function openNew() {
    const urlVars = [...new Set(collections.map((c) => baseUrlVar(c.baseUrl)).filter(Boolean))];
    const rows = urlVars.map((key) => ({ key: key as string, value: '', enabled: true }));
    rows.push({ key: '', value: '', enabled: true });
    editor.replace({ id: null, name: 'New Environment', rows, isDefault: false });
  }

  function openEdit(env: Environment) {
    const off = env.disabled || [];
    const rows = Object.entries(env.variables || {})
      .map(([key, value]) => ({ key, value, enabled: !off.includes(key) }));
    rows.push({ key: '', value: '', enabled: true });
    editor.replace({ id: env.id, name: env.name, rows, isDefault: !!env.isDefault });
  }

  async function closeEditor() {
    // Whatever was typed in the last 600ms is still only here.
    await editor.flush();
    editor.replace(null);
  }

  const activeEnv = environments.find((e) => e.id === activeEnvId);

  function changeEnv(value: string) {
    // The action entry never becomes the select's value — it is controlled by
    // activeEnvId, so it snaps back to the real selection on re-render.
    if (value === '__new') { openNew(); return; }
    onSelect(value || null);
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
              onChange={(e) => editor.edit({ ...editing, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') closeEditor(); }}
            />
            {/* Which environment a request's or flow's vars read `value` from —
                the column every other environment falls back to. */}
            <label className="env-default">
              <input
                type="checkbox"
                checked={editing.isDefault}
                onChange={(e) => editor.edit({ ...editing, isDefault: e.target.checked })}
              /> Default environment — request and flow vars use its values wherever another
              environment has none of its own
            </label>
            <KeyValueEditor
              rows={editing.rows}
              onChange={(rows) => editor.edit({ ...editing, rows })}
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
                    editor.replace(null); // deleted: a pending write would only bring it back
                  }}
                >Delete</button>
              )}
              <span className="spacer" />
              {editor.status && (
                <span className={`save-status ${editor.status === 'Save failed' ? 'err' : ''}`}>
                  {editor.status}
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
