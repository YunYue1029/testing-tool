import VarField from './VarField.tsx';
import useRowList from '../useRowList.ts';
import { emptyRow } from '../util.ts';
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
  const { shown, untouched, keyOf, update, remove } = useRowList(rows, onChange, emptyRow());

  return (
    <table className="kv">
      <tbody>
        {shown.map((row, i) => (
          <tr key={keyOf(row)}>
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
              {!untouched(row) && (
                <button title="Remove" onClick={() => remove(i)}>×</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
