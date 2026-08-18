import React, { useState } from 'react';
import KeyValueEditor from './KeyValueEditor';
import FormDataEditor from './FormDataEditor';
import VarField from './VarField';
import RequestVarsEditor from './RequestVarsEditor';
import RequestAuthEditor from './RequestAuthEditor';
import HelpTip from './HelpTip';
import { METHODS, emptyBody, activeBody, requestVars, usedVarNames } from '../util';
import type {
  AuthDescription, BodyType, FileMeta, HttpRequest, RequestBody,
  Vars,
} from '../types.ts';

interface RequestPanelProps {
  request: HttpRequest;
  onChange: (request: HttpRequest) => void;
  onSend: () => void;
  onCancel: () => void;
  onSave: () => void;
  sending: boolean;
  saveStatus: string;
  vars: Vars;
  crumb: string | null;
  composedUrl: string | null;
  urlVars: Vars;
  auth: AuthDescription;
  collectionName?: string;
  onUploadFile: (file: File) => Promise<FileMeta>;
  envVars: Vars;
}

export default function RequestPanel({
  request, onChange, onSend, onCancel, onSave, sending, saveStatus, vars, crumb, composedUrl, urlVars,
  auth, collectionName, onUploadFile, envVars,
}: RequestPanelProps) {
  const [tab, setTab] = useState('params');
  const set = (patch: Partial<HttpRequest>) => onChange({ ...request, ...patch });

  const body = activeBody(request);

  // The Vars tab wears a count of the values set here, and a red dot when a
  // {{token}} the request uses has no value anywhere — the thing you want to
  // notice before wondering why the URL went out with braces in it.
  const used = usedVarNames(request);
  const varCount = Object.keys(requestVars(request)).length;
  const unsetVars = used.filter((n) => !(n in (vars || {})));

  function setBodyContent(content: string) {
    set({
      bodies: (request.bodies || []).map((b) => (b.id === body?.id ? { ...b, content } : b)),
    });
  }

  function addBody() {
    const name = prompt('Body variant name:', `Variant ${(request.bodies || []).length + 1}`);
    if (!name) return;
    const nb = { ...emptyBody(name), content: body ? body.content : '' };
    set({ bodies: [...(request.bodies || []), nb], activeBodyId: nb.id });
  }

  function renameBody(b: RequestBody) {
    const name = prompt('Rename body variant:', b.name);
    if (!name || name === b.name) return;
    set({ bodies: (request.bodies || []).map((x) => (x.id === b.id ? { ...x, name } : x)) });
  }

  function deleteBody(b: RequestBody) {
    if (b.content.trim() && !confirm(`Delete body variant "${b.name}"?`)) return;
    const bodies = (request.bodies || []).filter((x) => x.id !== b.id);
    set({
      bodies,
      activeBodyId: b.id === request.activeBodyId ? bodies[0]!.id : request.activeBodyId,
    });
  }

  return (
    <div className="request-panel">
      {crumb && <div className="crumb">{crumb}</div>}
      <div className="url-bar">
        <select
          className={`method method-${request.method}`}
          value={request.method}
          onChange={(e) => set({ method: e.target.value })}
        >
          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <VarField
          className="url-input"
          vars={urlVars || vars}
          placeholder="https://api.example.com/users  ({{dy_url}} = base_url + folder path)"
          value={request.url}
          onChange={(e) => set({ url: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }}
        />
        {sending ? (
          <button className="btn-cancel" onClick={onCancel} title="Stop waiting for this request">
            Cancel
          </button>
        ) : (
          <button className="btn-send" onClick={onSend}>Send</button>
        )}
        <button className="btn-secondary" onClick={onSave}>Save</button>
        {saveStatus && (
          <span className={`save-status ${saveStatus === 'Save failed' ? 'err' : ''}`}>{saveStatus}</span>
        )}
      </div>
      {composedUrl && (
        <div className="url-effective" title="Full URL that will be sent">
          → {composedUrl}
        </div>
      )}
      <div className="tabs">
        <button className={tab === 'params' ? 'active' : ''} onClick={() => setTab('params')}>
          Params
        </button>
        <button className={tab === 'vars' ? 'active' : ''} onClick={() => setTab('vars')}>
          Vars{varCount ? ` ${varCount}` : ''}
          {unsetVars.length > 0 && <span className="auth-dot miss" />}
        </button>
        <button className={tab === 'auth' ? 'active' : ''} onClick={() => setTab('auth')}>
          Auth
          {/* No dot when nothing is sent — including a deliberate opt-out,
              where a red one would report a decision as a problem. */}
          {auth && auth.source !== 'none' && auth.source !== 'off' && (
            <span className={`auth-dot ${auth.resolved ? 'ok' : 'miss'}`} />
          )}
        </button>
        <button className={tab === 'headers' ? 'active' : ''} onClick={() => setTab('headers')}>
          Headers
        </button>
        <button className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>
          Body
        </button>
        <button className={tab === 'script' ? 'active' : ''} onClick={() => setTab('script')}>
          Script{(request.script || '').trim() ? ' •' : ''}
        </button>
      </div>

      <div className="tab-body">
        {tab === 'params' && (
          <KeyValueEditor rows={request.params} vars={vars} onChange={(params) => set({ params })} />
        )}
        {tab === 'vars' && (
          <RequestVarsEditor
            rows={request.vars || []}
            used={used}
            envVars={envVars}
            onChange={(v) => set({ vars: v })}
          />
        )}
        {tab === 'auth' && (
          <div className="auth-view">
            <RequestAuthEditor
              // A different request is a different set of held-open fields, and
              // the editor keeps those in state of its own.
              key={request.id}
              auth={request.auth}
              collectionName={collectionName}
              onChange={(a) => set({ auth: a })}
            />

            <div className="auth-outcome">
              {/* A Headers row filling in the same header beats the choice
                  above — the one case where the picker is not the answer, so
                  it is the one case worth naming. */}
              {auth && auth.source === 'request' && (
                <div className="auth-row">
                  <span className="auth-key">Note</span>
                  <span>A header on the Headers tab sets this directly, and takes over.</span>
                </div>
              )}
              {!auth || !auth.headerName ? (
                <p className="hint">
                  {!auth || auth.source === 'none'
                    ? collectionName
                      ? 'Nothing is sent — this collection has no default auth either.'
                      : 'Nothing is sent.'
                    : auth.source === 'off'
                      ? 'Nothing is sent — the collection default is refused.'
                      : 'Nothing is sent yet — this request’s own auth has no value.'}
                </p>
              ) : (
                <>
                  <div className="auth-row">
                    <span className="auth-key">Sends</span>
                    {/* The expression, not the value — a token is noise here,
                        and the point is only whether it will resolve. */}
                    <code>{auth.headerName}: {auth.expr}</code>
                  </div>
                  <div className="auth-row">
                    <span className="auth-key">Status</span>
                    <span className="auth-status">
                      <span className={`auth-dot ${auth.resolved ? 'ok' : 'miss'}`} />
                      {auth.resolved
                        ? 'Ready — resolves to a value in the active environment'
                        : auth.missing.length
                          ? <>Not set — <code>{auth.missing.join(', ')}</code> {auth.missing.length > 1 ? 'have' : 'has'} no value in the active environment</>
                          : 'Not set — the value is empty'}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {tab === 'headers' && (
          <KeyValueEditor rows={request.headers} vars={vars} onChange={(headers) => set({ headers })} />
        )}
        {tab === 'body' && (
          <div className="body-editor">
            <div className="body-type">
              {['none', 'json', 'text', 'form'].map((t) => (
                <label key={t}>
                  <input
                    type="radio"
                    name="bodyType"
                    checked={request.bodyType === t}
                    onChange={() => set({ bodyType: t as BodyType })}
                  />
                  {t === 'form' ? 'FORM-DATA' : t.toUpperCase()}
                </label>
              ))}
            </div>
            {request.bodyType === 'form' && (
              <FormDataEditor
                rows={request.form}
                vars={vars}
                onChange={(form) => set({ form })}
                onUploadFile={onUploadFile}
              />
            )}
            {request.bodyType !== 'none' && request.bodyType !== 'form' && (
              <>
                <div className="body-variants">
                  {(request.bodies || []).map((b) => (
                    <button
                      key={b.id}
                      className={`variant ${b.id === body?.id ? 'active' : ''}`}
                      onClick={() => set({ activeBodyId: b.id })}
                      onDoubleClick={() => renameBody(b)}
                      title="Double-click to rename"
                    >
                      {b.name}
                      {(request.bodies || []).length > 1 && (
                        <span
                          className="variant-del"
                          title="Delete variant"
                          onClick={(e) => { e.stopPropagation(); deleteBody(b); }}
                        >
                          ×
                        </span>
                      )}
                    </button>
                  ))}
                  <button className="variant-add" title="Add variant" onClick={addBody}>＋</button>
                </div>
                <VarField
                  multiline
                  fieldClass="body-text"
                  vars={vars}
                  placeholder={request.bodyType === 'json' ? '{\n  "key": "value"\n}' : 'Request body'}
                  value={body?.content || ''}
                  onChange={(e) => setBodyContent(e.target.value)}
                />
              </>
            )}
          </div>
        )}
        {tab === 'script' && (
          <div className="script-editor">
            <label className="field-label">
              Post-response script
              <HelpTip>
                Runs after each response. API: <code>res.status</code>, <code>res.headers</code>,{' '}
                <code>res.cookies</code>, <code>res.body</code>, <code>res.json()</code>,{' '}
                <code>env.get('name')</code>, <code>env.set('name', value)</code> — saved into the
                active environment.
              </HelpTip>
            </label>
            <textarea
              className="body-text"
              placeholder={'if (res.status === 200) {\n  env.set(\'token\', res.json().access_token);\n}'}
              value={request.script || ''}
              onChange={(e) => set({ script: e.target.value })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
