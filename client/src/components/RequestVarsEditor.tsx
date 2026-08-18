import React from 'react';
import KeyValueEditor from './KeyValueEditor';
import HelpTip from './HelpTip';
import { emptyRow } from '../util';
import type { Row, Vars } from '../types.ts';

// Values that belong to one request. A fetch-one call needs a {{user_id}} that
// nothing else cares about; putting every such id in an environment buries the
// handful of variables that are genuinely shared, so they live here instead and
// override the environment when the request runs.
interface RequestVarsEditorProps {
  rows: Row[];
  used: string[];
  envVars: Vars;
  onChange: (rows: Row[]) => void;
}

export default function RequestVarsEditor({ rows, used, envVars, onChange }: RequestVarsEditorProps) {
  const list = rows && rows.length ? rows : [emptyRow()];
  const named = new Set(list.filter((r) => r.key).map((r) => r.key));

  // Tokens the request uses that neither it nor the environment defines —
  // exactly the ones that would go out unresolved, so offer them by name.
  const missing = (used || []).filter((n) => !named.has(n) && !(n in (envVars || {})));
  // Names answered here that the environment also defines: worth saying, since
  // the request's value silently wins.
  const shadowed = [...named].filter((n) => n in (envVars || {}));

  function add(name: string) {
    const kept = list.filter((r) => r.key || r.value);
    onChange([...kept, { key: name, value: '', enabled: true }, emptyRow()]);
  }

  return (
    <div className="req-vars">
      <label className="field-label">
        Request variables
        <HelpTip>
          Values for this request only — they override the active environment, so an id
          you need for a single call doesn&apos;t have to be declared there. Clear a value
          to fall back to the environment again.
        </HelpTip>
      </label>
      {missing.length > 0 && (
        <div className="var-chips">
          <span className="hint">Used here, not set anywhere:</span>
          {missing.map((n) => (
            <button key={n} className="var-chip" title={`Add ${n}`} onClick={() => add(n)}>
              {n} ＋
            </button>
          ))}
        </div>
      )}
      <KeyValueEditor
        rows={list}
        onChange={onChange}
        keyPlaceholder="Variable"
        valuePlaceholder="Value"
      />
      {shadowed.length > 0 && (
        <p className="hint">
          Overriding the environment: <code>{shadowed.join(', ')}</code>
        </p>
      )}
    </div>
  );
}
