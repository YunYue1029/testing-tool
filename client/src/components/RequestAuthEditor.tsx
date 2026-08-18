import React, { useState } from 'react';
import HelpTip from './HelpTip';
import { authFormState, authToStore } from '../util';
import type { Auth, CollectionAuth } from '../types.ts';
import type { AuthForm } from '../types.ts';

const TYPES = [
  ['inherit', 'Inherit from collection'],
  ['none', 'No Auth'],
  ['bearer', 'Bearer Token'],
  ['apikey', 'API Key (header)'],
];

// What a request sends for authentication: the collection's default, its own,
// or nothing. 'No Auth' is what a login needs — the collection default is the
// very token the login exists to replace, and a backend that reads anything
// from the token it was handed (a timezone claim, a tenant) answers the login
// as that stale token's user.
//
// The fields of every type are held here rather than on the request, so
// switching to No Auth and back doesn't lose the token you just typed; only
// the chosen type's fields are handed up to be stored.
// `label` names the field, since what reads as "Type" next to a request's Auth
// tab needs saying in full beside a step's body type and mode.
interface RequestAuthEditorProps {
  auth: Auth | CollectionAuth | null | undefined;
  collectionName?: string;
  label?: string;
  onChange: (auth: Auth) => void;
}

export default function RequestAuthEditor(
  { auth, collectionName, label = 'Type', onChange }: RequestAuthEditorProps,
) {
  const [form, setForm] = useState(() => authFormState(auth, 'inherit'));

  function set(patch: Partial<AuthForm>) {
    const next = { ...form, ...patch };
    setForm(next);
    onChange(authToStore(next));
  }

  return (
    <div className="auth-editor">
      <label className="field-label">
        {label}
        <HelpTip>
          Inheriting sends whatever the collection defaults to. Choose anything else and
          this request answers for itself — <em>No Auth</em> for a login, or anything that
          must run unauthenticated. A header of your own setting the same name still wins
          over all of it.
        </HelpTip>
      </label>
      <select value={form.type} onChange={(e) => set({ type: e.target.value })}>
        {TYPES.map(([value, label]) => (
          <option key={value} value={value}>
            {value === 'inherit' && collectionName ? `${label} — ${collectionName}` : label}
          </option>
        ))}
      </select>

      {form.type === 'bearer' && (
        <div className="auth-fields">
          <label className="field-label">Prefix</label>
          <input value={form.prefix} placeholder="Bearer" onChange={(e) => set({ prefix: e.target.value })} />
          <label className="field-label">Token</label>
          <input value={form.token} placeholder="{{token}}" onChange={(e) => set({ token: e.target.value })} />
        </div>
      )}

      {form.type === 'apikey' && (
        <div className="auth-fields">
          <label className="field-label">Header name</label>
          <input value={form.header} placeholder="X-API-Key" onChange={(e) => set({ header: e.target.value })} />
          <label className="field-label">Value</label>
          <input value={form.value} placeholder="{{token}}" onChange={(e) => set({ value: e.target.value })} />
        </div>
      )}
    </div>
  );
}
