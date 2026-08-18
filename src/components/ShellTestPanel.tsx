import React, { useState } from 'react';
import VarField from './VarField';
import RequestVarsEditor from './RequestVarsEditor';
import HelpTip from './HelpTip';
import { usedVarNames, requestVars } from '../util';
import type { ShellRequest, Vars } from '../types.ts';

// A saved test that runs a command. It sits where the request panel sits and is
// run by the same button, because it answers the same question — did the thing
// I changed work — for the half of a feature no HTTP response can show: the row
// in the table, the file on disk, the queue that drained.
//
// Deliberately not the request panel with its fields hidden: a command has no
// method, no headers, no body and no auth, and a panel offering six tabs that
// mean nothing would be six invitations to wonder what they do here.
interface ShellTestPanelProps {
  test: ShellRequest;
  onChange: (test: ShellRequest) => void;
  onRun: () => void;
  onCancel: () => void;
  onSave: () => void;
  running: boolean;
  saveStatus: string;
  vars: Vars;
  envVars: Vars;
  crumb: string | null;
  resolvedCommand: string;
}

export default function ShellTestPanel({
  test, onChange, onRun, onCancel, onSave, running, saveStatus, vars, envVars, crumb,
  resolvedCommand,
}: ShellTestPanelProps) {
  const [tab, setTab] = useState('vars');
  const set = (patch: Partial<ShellRequest>) => onChange({ ...test, ...patch });

  const used = usedVarNames(test);
  const varCount = Object.keys(requestVars(test)).length;
  const unsetVars = used.filter((n) => !(n in (vars || {})));

  return (
    <div className="request-panel">
      {crumb && <div className="crumb">{crumb}</div>}
      <div className="url-bar">
        {/* Where the method dropdown is on a request — a prompt, so the two
            panels line up and this one is recognisable at a glance. */}
        <span className="shell-prompt" title="This test runs a command instead of sending a request">$</span>
        <VarField
          className="url-input"
          fieldClass="shell-command"
          vars={vars}
          spellCheck={false}
          placeholder='docker exec db psql -tAc "select count(*) from users where id={{user_id}}"'
          value={test.command || ''}
          onChange={(e) => set({ command: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') onRun(); }}
        />
        {running ? (
          <button className="btn-cancel" onClick={onCancel} title="Stop waiting for this command">
            Cancel
          </button>
        ) : (
          <button className="btn-send" onClick={onRun}>Run</button>
        )}
        <button className="btn-secondary" onClick={onSave}>Save</button>
        {saveStatus && (
          <span className={`save-status ${saveStatus === 'Save failed' ? 'err' : ''}`}>{saveStatus}</span>
        )}
      </div>
      {/* The line as it will actually run, once its {{vars}} are filled in —
          the same service the composed URL does for a request. */}
      {resolvedCommand && (
        <div className="url-effective" title="The command that will run">
          → {resolvedCommand}
        </div>
      )}

      <div className="shell-where">
        <VarField
          className="shell-cwd"
          fieldClass="shell-command"
          vars={vars}
          spellCheck={false}
          placeholder="Run it in… (this server’s own directory unless you say)"
          value={test.cwd || ''}
          onChange={(e) => set({ cwd: e.target.value })}
        />
        <input
          className="shell-timeout"
          type="number"
          min="0"
          value={test.timeout || ''}
          placeholder="30000"
          title="Timeout in ms — the command is killed past it (default 30000)"
          onChange={(e) => set({ timeout: Number(e.target.value) || undefined })}
        />
      </div>

      <div className="tabs">
        <button className={tab === 'vars' ? 'active' : ''} onClick={() => setTab('vars')}>
          Vars{varCount ? ` ${varCount}` : ''}
          {unsetVars.length > 0 && <span className="auth-dot miss" />}
        </button>
        <button className={tab === 'script' ? 'active' : ''} onClick={() => setTab('script')}>
          Script{(test.script || '').trim() ? ' •' : ''}
        </button>
      </div>

      <div className="tab-body">
        {tab === 'vars' && (
          <RequestVarsEditor
            rows={test.vars || []}
            used={used}
            envVars={envVars}
            onChange={(v) => set({ vars: v })}
          />
        )}
        {tab === 'script' && (
          <div className="script-editor">
            <label className="field-label">
              Post-run script
              <HelpTip>
                Runs after the command. API: <code>sh.exitCode</code>, <code>sh.stdout</code>,{' '}
                <code>sh.stderr</code>, <code>sh.timeMs</code> — and the same <code>res</code> a
                request gets, where <code>res.status</code> is the exit code and{' '}
                <code>res.body</code> is stdout. <code>env.set(&apos;name&apos;, value)</code> saves
                into the active environment.
              </HelpTip>
            </label>
            <textarea
              className="body-text"
              placeholder={"if (sh.exitCode === 0) {\n  env.set('row_count', sh.stdout.trim());\n}"}
              value={test.script || ''}
              onChange={(e) => set({ script: e.target.value })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
