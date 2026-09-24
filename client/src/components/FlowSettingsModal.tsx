import { useLayoutEffect, useRef } from 'react';
import RequestVarsEditor from './RequestVarsEditor.tsx';
import { fitToContent } from '../util.ts';
import type { Environment, Flow, FlowShell, Vars } from '../types.ts';

// Everything about a flow that is set once and then left alone — its name and
// description, the environment it runs in, its variables and its shell — in
// one dialog behind the pencil by the title, so the panel itself is the steps.
// Edits apply as they are typed, the way the rest of a flow saves itself, so
// there is nothing to confirm on the way out.
interface FlowSettingsModalProps {
  flow: Flow;
  onChange: (flow: Flow) => void;
  onClose: () => void;
  onDelete: () => void;
  environments: Environment[];
  // The environment the flow's vars read as — its own if it names one.
  activeEnvId: string | null;
  envVars: Vars;
  usedVars: string[];
  // The shell settings only mean something to a flow that runs commands.
  hasShellStep: boolean;
}

export default function FlowSettingsModal({
  flow, onChange, onClose, onDelete, environments, activeEnvId, envVars, usedVars, hasShellStep,
}: FlowSettingsModalProps) {
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => { fitToContent(descRef.current); }, [flow.description]);

  const shell = flow.shell || ({} as Partial<FlowShell>);
  const oneShell = shell.session !== false;
  const setShell = (patch: Partial<FlowShell>) => onChange({
    ...flow, shell: { session: oneShell, cwd: shell.cwd || '', ...patch },
  });

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="modal modal-wide flow-settings">
        <h3>Flow settings</h3>

        <div className="field-label">Name</div>
        <input
          className="modal-name"
          value={flow.name}
          placeholder="Flow name"
          autoFocus
          onChange={(e) => onChange({ ...flow, name: e.target.value })}
        />

        <div className="field-label">Description</div>
        <textarea
          ref={descRef}
          className="body-text flow-settings-desc"
          value={flow.description || ''}
          placeholder="What this flow proves — the case it covers, and anything it assumes"
          rows={3}
          onChange={(e) => {
            fitToContent(e.target);
            onChange({ ...flow, description: e.target.value });
          }}
        />

        {/* Pinned, the flow runs here whatever the bar above has selected —
            for a flow that only makes sense against one deployment. */}
        <div className="field-label">Runs in</div>
        <select
          value={flow.environmentId || ''}
          onChange={(e) => onChange({ ...flow, environmentId: e.target.value || null })}
        >
          <option value="">The environment selected above</option>
          {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>

        <RequestVarsEditor
          rows={flow.vars || []}
          used={usedVars}
          envVars={envVars}
          environments={environments}
          activeEnvId={activeEnvId}
          onChange={(vars) => onChange({ ...flow, vars })}
          title="Variables"
          help={(
            <>
              Values this flow runs with — they override the active environment and a
              saved request&apos;s own values, and a step that captures the same name
              overrides them. An input only this flow needs belongs here rather than in
              an environment.
            </>
          )}
        />

        {hasShellStep && (
          <>
            <div className="field-label">Shell</div>
            <div className="flow-shell-bar">
              <label title={'One shell for every command in this flow, so a cd, an export or a sourced '
                + 'env reaches the steps after it. Unchecked, each command gets a shell of its own and '
                + 'starts from nothing.'}>
                <input
                  type="checkbox"
                  checked={oneShell}
                  onChange={(e) => setShell({ session: e.target.checked })}
                /> one shell for the whole run
              </label>
              <input
                className="flow-shell-cwd"
                value={shell.cwd || ''}
                spellCheck={false}
                placeholder="Working directory — the server’s own unless you say"
                title={oneShell
                  ? 'Where the shell starts. A step that names its own directory cds there, and stays.'
                  : 'Where each command runs, unless the step names its own.'}
                onChange={(e) => setShell({ cwd: e.target.value })}
              />
            </div>
          </>
        )}

        <div className="modal-actions">
          {/* Down here, away from everything used every day: deleting a flow
              is the one thing on this dialog that cannot be undone. */}
          <button className="btn-danger" onClick={onDelete}>Delete flow</button>
          <span className="spacer" />
          <button className="btn-send" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
