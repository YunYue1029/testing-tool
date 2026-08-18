import React, { useState } from 'react';
import HelpTip from './HelpTip';
import { authFormState, authToStore } from '../util';
import type { Auth, AuthForm, Collection } from '../types.ts';

// Everything a collection is, edited in one place: the sidebar's pencil opens
// this, so the name sits alongside the base URL and the default Authentication
// applied to requests that don't set their own Authorization / key header.
interface CollectionSettingsModalProps {
  collection: Collection;
  onSave: (fields: { name: string; auth: Auth; baseUrl: string }) => void;
  onCancel: () => void;
}

export default function CollectionSettingsModal(
  { collection, onSave, onCancel }: CollectionSettingsModalProps,
) {
  const [auth, setAuth] = useState(() => authFormState(collection.auth));
  const [name, setName] = useState(collection.name || '');
  const [baseUrl, setBaseUrl] = useState(collection.baseUrl || '');
  const set = (patch: Partial<AuthForm>) => setAuth((a) => ({ ...a, ...patch }));

  function submit() {
    // An empty box is a slip, not a request for a nameless collection.
    const nextName = name.trim() || collection.name;
    onSave({ name: nextName, auth: authToStore(auth), baseUrl: baseUrl.trim() });
  }

  return (
    <div className="modal-backdrop">
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
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
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
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-send" onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  );
}
