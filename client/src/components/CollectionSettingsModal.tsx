import { useEffect } from 'react';
import HelpTip from './HelpTip.tsx';
import useAutoSave from '../useAutoSave.ts';
import { authFormState, authToStore } from '../util.ts';
import type { Auth, AuthForm, Collection } from '../types.ts';

// Everything a collection is, edited in one place: the sidebar's pencil opens
// this, so the name sits alongside the base URL and the default Authentication
// applied to requests that don't set their own Authorization / key header.
interface CollectionSettingsModalProps {
  collection: Collection;
  onSave: (fields: { name: string; auth: Auth; baseUrl: string }) => Promise<unknown> | unknown;
  onClose: () => void;
}

// The dialog's fields, as typed.
interface SettingsForm {
  name: string;
  auth: AuthForm;
  baseUrl: string;
}

const formOf = (c: Collection): SettingsForm =>
  ({ name: c.name || '', auth: authFormState(c.auth), baseUrl: c.baseUrl || '' });

// What the form writes. An empty box is a slip, not a request for a
// nameless collection.
const fieldsOf = (f: SettingsForm, c: Collection) =>
  ({ name: f.name.trim() || c.name, auth: authToStore(f.auth), baseUrl: f.baseUrl.trim() });

export default function CollectionSettingsModal(
  { collection, onSave, onClose }: CollectionSettingsModalProps,
) {
  // Saved as it is edited, like the requests inside it: a base URL changed on
  // the way to sending something is a change nobody comes back to confirm.
  const form = useAutoSave<SettingsForm>(() => formOf(collection), (f) => onSave(fieldsOf(f, collection)));
  const { name, auth, baseUrl } = form.draft!;
  const edit = (patch: Partial<SettingsForm>) => form.edit((f) => ({ ...f!, ...patch }));
  const set = (patch: Partial<AuthForm>) => edit({ auth: { ...auth, ...patch } });

  // The collection can change under the dialog — the poll brings in an edit
  // made elsewhere — and a form copied once would go on showing the old
  // values. Take the new ones when nothing here is waiting to be written and
  // they differ from what this form would write; a save of our own answers
  // with exactly that, so it changes nothing.
  useEffect(() => {
    if (form.dirty) return;
    const mine = JSON.stringify(fieldsOf(form.draft!, collection));
    const theirs = JSON.stringify(fieldsOf(formOf(collection), collection));
    if (mine !== theirs) form.replace(formOf(collection));
    // Only a new prop is a reason to look; the draft's own changes are edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection]);

  async function close() {
    // Whatever was typed in the last 600ms is still only here.
    await form.flush();
    onClose();
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="modal">
        <h3>Edit collection</h3>

        <div className="settings-section">
          <div className="settings-section-title">Name</div>
          <input
            className="modal-name"
            value={name}
            placeholder={collection.name}
            autoFocus
            onChange={(e) => edit({ name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') close(); }}
          />
        </div>

        <div className="settings-section">
          <div className="settings-section-title">
            Base URL
            <HelpTip>
              Overrides <code>{'{{base_url}}'}</code> for every request in this collection —
              point each service/container&apos;s collection at its own host. May use{' '}
              <code>{'{{vars}}'}</code>. Empty = environment&apos;s <code>base_url</code> or the default.
            </HelpTip>
          </div>
          <input
            className="modal-name"
            value={baseUrl}
            placeholder="http://localhost:8001"
            onChange={(e) => edit({ baseUrl: e.target.value })}
          />
        </div>

        <div className="settings-section">
          <div className="settings-section-title">
            Authentication
            <HelpTip>
              Added to every request in this collection that doesn&apos;t set its own header.
              Values may use <code>{'{{vars}}'}</code>.
            </HelpTip>
          </div>

          <label className="field-label">Type</label>
          <select className="modal-name" value={auth.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="none">No Auth</option>
            <option value="bearer">Bearer Token</option>
            <option value="apikey">API Key (header)</option>
          </select>

          {auth.type === 'bearer' && (
            <>
              <label className="field-label">Prefix</label>
              <input
                className="modal-name"
                value={auth.prefix}
                placeholder="Bearer"
                onChange={(e) => set({ prefix: e.target.value })}
              />
              <label className="field-label">Token</label>
              <input
                className="modal-name"
                value={auth.token}
                placeholder="{{token}}"
                onChange={(e) => set({ token: e.target.value })}
              />
              <p className="hint">→ <code>Authorization: {`${auth.prefix ? `${auth.prefix} ` : ''}${auth.token}`}</code></p>
            </>
          )}

          {auth.type === 'apikey' && (
            <>
              <label className="field-label">Header name</label>
              <input
                className="modal-name"
                value={auth.header}
                placeholder="X-API-Key"
                onChange={(e) => set({ header: e.target.value })}
              />
              <label className="field-label">Value</label>
              <input
                className="modal-name"
                value={auth.value}
                placeholder="{{token}}"
                onChange={(e) => set({ value: e.target.value })}
              />
              <p className="hint">→ <code>{`${auth.header || 'Header'}: ${auth.value}`}</code></p>
            </>
          )}
        </div>

        <div className="modal-actions">
          <span className="spacer" />
          {form.status && (
            <span className={`save-status ${form.status === 'Save failed' ? 'err' : ''}`}>
              {form.status}
            </span>
          )}
          <button className="btn-send" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
