import React from 'react';
import HelpTip from './HelpTip';
import { emptyRow } from '../util';
import type { Environment, Row, Vars } from '../types.ts';

// Values that belong to one request. A fetch-one call needs a {{user_id}} that
// nothing else cares about; putting every such id in an environment buries the
// handful of variables that are genuinely shared, so they live here instead and
// override the environment when the request runs.
//
// One column per environment, because the same id is rarely the same id on
// another deployment. The default environment's column is the row's `value`,
// which every other environment falls back to; theirs are `byEnv`, filled in
// only where the value really differs, and an empty one shows what it falls
// back to.
interface RequestVarsEditorProps {
  rows: Row[];
  used: string[];
  envVars: Vars;
  onChange: (rows: Row[]) => void;
  environments: Environment[];
  // The environment whose column a run reads, marked so it is clear which
  // value is live.
  activeEnvId: string | null;
  // A flow's variables are edited with this same list; it says whose they are.
  title?: string;
  help?: React.ReactNode;
}

export default function RequestVarsEditor({
  rows, used, envVars, onChange, environments, activeEnvId, title = 'Request variables', help,
}: RequestVarsEditorProps) {
  const list = rows && rows.length ? rows : [emptyRow()];
  const named = new Set(list.filter((r) => r.key).map((r) => r.key));

  // The default environment's column comes first and is the row's own value;
  // with none marked, that column is simply the default.
  const def = environments.find((e) => e.isDefault) || null;
  const others = environments.filter((e) => e !== def);
  // Whose column a run reads now: the selected environment's if it has one
  // here, the default column otherwise — no environment, or the default one.
  const liveId = others.some((e) => e.id === activeEnvId) ? activeEnvId : null;

  // Tokens the request uses that neither it nor the environment defines —
  // exactly the ones that would go out unresolved, so offer them by name.
  const missing = (used || []).filter((n) => !named.has(n) && !(n in (envVars || {})));
  // Names answered here that the environment also defines: worth saying, since
  // the request's value silently wins — but only where there is a value in
  // play for the selected environment. An empty one falls back to the
  // environment, so it overrides nothing.
  const inPlay = (r: Row) => !!(((liveId && (r.byEnv || {})[liveId]) || r.value));
  const shadowed = list
    .filter((r) => r.key && r.enabled !== false && inPlay(r) && r.key in (envVars || {}))
    .map((r) => r.key);

  const untouched = (r: Row) => !r.key && !r.value && !Object.values(r.byEnv || {}).some(Boolean);

  function update(i: number, patch: Partial<Row>) {
    let next = list.map((r, k) => (k === i ? { ...r, ...patch } : r));
    // Always a blank row at the bottom, so adding one needs no button.
    if (!untouched(next[next.length - 1]!)) next = [...next, emptyRow()];
    onChange(next);
  }

  function setEnvValue(i: number, envId: string, value: string) {
    const byEnv = { ...(list[i]!.byEnv || {}) };
    if (value) byEnv[envId] = value;
    else delete byEnv[envId];
    update(i, { byEnv });
  }

  function remove(i: number) {
    const next = list.filter((_, k) => k !== i);
    onChange(next.length ? next : [emptyRow()]);
  }

  function add(name: string) {
    const kept = list.filter((r) => !untouched(r));
    onChange([...kept, { key: name, value: '', enabled: true }, emptyRow()]);
  }

  const head = (e: Environment | null) => {
    const live = e === def ? liveId === null : e!.id === liveId;
    return (
      <th className={live ? 'live' : ''} title={live ? 'The environment selected now — its value is the one used' : undefined}>
        {e ? e.name : 'Default'}
        {e && e.isDefault && <span className="hint-inline"> · default</span>}
      </th>
    );
  };

  return (
    <div className="req-vars">
      <label className="field-label">
        {title}
        <HelpTip>
          {help || (
            <>
              Values for this request only — they override the active environment, so an id
              you need for a single call doesn&apos;t have to be declared there. Clear a value
              to fall back to the environment again.
            </>
          )}
          {' '}Each environment has its own column; one left empty uses the
          {def ? ` ${def.name}` : ' default'} value.
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
      <div className="vars-scroll">
        <table className="kv vars-by-env">
          <thead>
            <tr>
              <th className="kv-check" />
              <th>Variable</th>
              {head(def)}
              {others.map((e) => <React.Fragment key={e.id}>{head(e)}</React.Fragment>)}
              <th className="kv-del" />
            </tr>
          </thead>
          <tbody>
            {list.map((row, i) => (
              <tr key={i}>
                <td className="kv-check">
                  <input
                    type="checkbox"
                    checked={row.enabled !== false}
                    onChange={(e) => update(i, { enabled: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    value={row.key}
                    placeholder="Variable"
                    onChange={(e) => update(i, { key: e.target.value })}
                  />
                </td>
                <td className={liveId === null ? 'live' : ''}>
                  <input
                    value={row.value}
                    placeholder="Value"
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                </td>
                {others.map((e) => (
                  <td key={e.id} className={e.id === liveId ? 'live' : ''}>
                    <input
                      value={(row.byEnv || {})[e.id] || ''}
                      // What it falls back to, greyed: an empty cell is not
                      // "nothing", it is the default's value.
                      placeholder={row.value || '—'}
                      onChange={(ev) => setEnvValue(i, e.id, ev.target.value)}
                    />
                  </td>
                ))}
                <td className="kv-del">
                  {!untouched(row) && <button title="Remove" onClick={() => remove(i)}>×</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shadowed.length > 0 && (
        <p className="hint">
          Overriding the environment: <code>{shadowed.join(', ')}</code>
        </p>
      )}
    </div>
  );
}
