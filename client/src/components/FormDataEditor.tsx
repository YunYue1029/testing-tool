import React, { useRef, useState } from 'react';
import VarField from './VarField';
import { IconClose } from './Icons';
import { emptyFormRow } from '../util';
import type { FileMeta, FormRow, Vars } from '../types.ts';

// Whichever fields a row is being edited through. Not Partial<FormRow>: the
// two row types disagree on `type`, so an intersection of them is empty and a
// union cannot describe a patch that touches `type` and `value` at once.
interface FormRowPatch {
  key?: string;
  type?: 'text' | 'file';
  value?: string;
  enabled?: boolean;
  fileId?: string | undefined;
  fileName?: string | undefined;
  fileSize?: number | undefined;
  fileHint?: string;
}

function humanSize(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// multipart/form-data fields: each row is either a text value or a file. Files
// are uploaded to the server as soon as they are picked, and the row keeps the
// resulting id — so a saved request can be sent again later without re-picking.
interface FormDataEditorProps {
  rows: FormRow[] | undefined;
  onChange: (rows: FormRow[]) => void;
  vars: Vars;
  onUploadFile: (file: File) => Promise<FileMeta>;
}

export default function FormDataEditor(
  { rows, onChange, vars, onUploadFile }: FormDataEditorProps,
) {
  const list = rows && rows.length ? rows : [emptyFormRow()];
  const [busy, setBusy] = useState<number | null>(null); // index currently uploading
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});

  function update(i: number, patch: FormRowPatch) {
    let next: FormRow[] = list.map(
      (r, idx) => (idx === i ? ({ ...r, ...patch } as FormRow) : r),
    );
    // Ensure a trailing empty row exists.
    const last = next[next.length - 1];
    if (last!.key || last!.value || ('fileId' in last! && last!.fileId)) {
      next = [...next, emptyFormRow()];
    }
    onChange(next);
  }

  function remove(i: number) {
    const next = list.filter((_, idx) => idx !== i);
    onChange(next.length ? next : [emptyFormRow()]);
  }

  async function pickFile(i: number, file: File | undefined) {
    if (!file) return;
    setBusy(i);
    try {
      const meta = await onUploadFile(file);
      update(i, { fileId: meta.id, fileName: meta.name, fileSize: meta.size });
    } catch (e) {
      alert(`Upload failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <table className="kv form-kv">
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
              <VarField
                vars={vars}
                value={row.key}
                placeholder="Field name"
                onChange={(e) => update(i, { key: e.target.value })}
              />
            </td>
            <td className="form-type">
              <select
                value={row.type === 'file' ? 'file' : 'text'}
                onChange={(e) => update(i, {
                  type: e.target.value as 'text' | 'file',
                  // Switching type drops the other kind's payload, so a row
                  // can't send a stale value it no longer shows.
                  ...(e.target.value === 'text'
                    ? { fileId: undefined, fileName: undefined, fileSize: undefined }
                    : { value: '' }),
                })}
              >
                <option value="text">Text</option>
                <option value="file">File</option>
              </select>
            </td>
            <td>
              {row.type === 'file' ? (
                <div className="form-file">
                  <button
                    className="btn-secondary"
                    disabled={busy === i}
                    onClick={() => fileRefs.current[i]?.click()}
                  >{busy === i ? 'Uploading…' : 'Choose file'}</button>
                  <span
                    className="form-file-name"
                    title={('fileName' in row && row.fileName) || ('fileHint' in row && row.fileHint) || ''}
                  >
                    {row.fileName
                      ? <>{row.fileName} <span className="hint-inline">{humanSize(row.fileSize)}</span></>
                      // An imported Postman file field: the export carries the
                      // exporting machine's path, never the bytes.
                      : row.fileHint
                        ? <span className="hint-inline">was {row.fileHint} — pick it again</span>
                        : <span className="hint-inline">No file selected</span>}
                  </span>
                  <input
                    ref={(el) => { fileRefs.current[i] = el; }}
                    type="file"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      pickFile(i, file);
                    }}
                  />
                </div>
              ) : (
                <VarField
                  vars={vars}
                  value={row.value}
                  placeholder="Value"
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              )}
            </td>
            <td className="kv-del">
              {(row.key || row.value || ('fileId' in row && row.fileId)) && (
                <button className="mini danger" title="Remove" onClick={() => remove(i)}>
                  <IconClose />
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
