import React from 'react';
import VarField from './VarField';
import { emptyRow } from '../util';
import type { Row, Vars } from '../types.ts';

// Editable table of key/value rows with an enable checkbox. Always keeps one
// blank trailing row so the user can add more without a button.
// Pass `vars` to highlight {{var}} tokens (params/headers); omit it for plain
// inputs (the environment editor itself).
interface KeyValueEditorProps {
  rows: Row[] | undefined;
  onChange: (rows: Row[]) => void;
  vars?: Vars;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export default function KeyValueEditor(
  { rows, onChange, vars, keyPlaceholder = 'Key', valuePlaceholder = 'Value' }: KeyValueEditorProps,
) {
  const list = rows && rows.length ? rows : [emptyRow()];

  function update(i: number, patch: Partial<Row>) {
    let next = list.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    // Ensure a trailing empty row exists.
    const last = next[next.length - 1];
    if (last!.key || last!.value) next = [...next, emptyRow()];
    onChange(next);
  }

  function remove(i: number) {
    const next = list.filter((_, idx) => idx !== i);
    onChange(next.length ? next : [emptyRow()]);
  }

  return (
    <table className="kv">
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
              {vars
                ? (
                  <VarField
                    vars={vars}
                    value={row.key}
                    placeholder={keyPlaceholder}
                    onChange={(e) => update(i, { key: e.target.value })}
                  />
                )
                : (
                  <input
                    value={row.key}
                    placeholder={keyPlaceholder}
                    onChange={(e) => update(i, { key: e.target.value })}
                  />
                )}
            </td>
            <td>
              {vars
                ? (
                  <VarField
                    vars={vars}
                    value={row.value}
                    placeholder={valuePlaceholder}
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                )
                : (
                  <input
                    value={row.value}
                    placeholder={valuePlaceholder}
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                )}
            </td>
            <td className="kv-del">
              {(row.key || row.value) && (
                <button title="Remove" onClick={() => remove(i)}>×</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
