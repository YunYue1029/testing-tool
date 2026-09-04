import React, { useState, useMemo } from 'react';
import HelpTip from './HelpTip';
import useAutoSave from '../useAutoSave';
import { authFormState, authToStore } from '../util';
import type { Auth, AuthForm, Collection } from '../types.ts';

// Everything a collection is, edited in one place: the sidebar's pencil opens
// this, so the name sits alongside the base URL and the default Authentication
// applied to requests that don't set their own Authorization / key header.
interface CollectionSettingsModalProps {
  collection: Collection;
  onSave: (fields: { name: string; auth: Auth; baseUrl: string }) => Promise<unknown> | unknown;
  onClose: () => void;
}

export default function CollectionSettingsModal(
  { collection, onSave, onClose }: CollectionSettingsModalProps,
) {
  const [auth, setAuth] = useState(() => authFormState(collection.auth));
  const [name, setName] = useState(collection.name || '');
  const [baseUrl, setBaseUrl] = useState(collection.baseUrl || '');
  const set = (patch: Partial<AuthForm>) => setAuth((a) => ({ ...a, ...patch }));

  // An empty box is a slip, not a request for a nameless collection.
  const fields = useMemo(
    () => ({ name: name.trim() || collection.name, auth: authToStore(auth), baseUrl: baseUrl.trim() }),
    [name, auth, baseUrl, collection.name],
  );
  // Saved as it is edited, like the requests inside it: a base URL changed on
  // the way to sending something is a change nobody comes back to confirm.
  const autoSave = useAutoSave(fields, onSave);

  async function close() {
    // Whatever was typed in the last 600ms is still only here.
    await autoSave.flush();
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
            onChange={(e) => setName(e.target.value)}
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
            onChange={(e) => setBaseUrl(e.target.value)}
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
          {autoSave.status && (
            <span className={`save-status ${autoSave.status === 'Save failed' ? 'err' : ''}`}>
              {autoSave.status}
            </span>
          )}
          <button className="btn-send" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
