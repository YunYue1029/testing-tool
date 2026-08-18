import React, { useState } from 'react';
import HelpTip from './HelpTip';

// The sidebar's two halves, plus the context they both resolve against. Same
// three sections the server splits an export/import into, in the order the
// sidebar shows them.
export const SECTIONS = [
  {
    key: 'tests',
    label: 'Tests',
    note: 'Collections, their folders and every saved request',
  },
  {
    key: 'flows',
    label: 'Flows',
    note: 'Flows and the folders they are filed under',
  },
  {
    key: 'environments',
    label: 'Environments',
    note: 'Environment variables and the saved base URLs',
  },
];

// Picking what crosses between two machines, in either direction. Exporting,
// the counts are what this workspace holds; importing, what the file holds —
// and a section the file has none of cannot be picked, because there would be
// nothing to write.
interface TransferModalProps {
  mode: 'export' | 'import';
  counts: Record<string, number>;
  exportedAt?: string;
  onConfirm: (include: string[]) => void;
  onCancel: () => void;
}

export default function TransferModal(
  { mode, counts, exportedAt, onConfirm, onCancel }: TransferModalProps,
) {
  const importing = mode === 'import';
  const available = SECTIONS.filter((s) => !importing || counts[s.key] !== undefined);
  const [picked, setPicked] = useState(
    () => new Set(available.filter((s) => counts[s.key] > 0).map((s) => s.key))
  );

  const toggle = (key: string) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  // Order is the server's, not the click order: it ends up in the filename and
  // in the file's `contents`, and those read better fixed.
  const chosen = SECTIONS.map((s) => s.key).filter((k) => picked.has(k));
  const all = chosen.length === available.length && available.length === SECTIONS.length;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>
          {importing ? 'Import from file' : 'Export to file'}
          <HelpTip>
            {importing
              ? <>Only the parts you tick are written. Anything here with the same id is
                overwritten; the rest is left alone.</>
              : <>One file, for another machine to import. Ids travel with it, so importing
                it twice updates rather than duplicates.</>}
          </HelpTip>
        </h3>
        {importing && exportedAt && (
          <p className="hint">Exported {new Date(exportedAt).toLocaleString()}.</p>
        )}

        <div className="settings-section">
          <div className="settings-section-title">What to {importing ? 'import' : 'export'}</div>
          {SECTIONS.map((s) => {
            const has = !importing || counts[s.key] !== undefined;
            const n = counts[s.key];
            return (
              <label
                key={s.key}
                title={s.note}
                className={`transfer-row${has ? '' : ' is-absent'}`}
              >
                <input
                  type="checkbox"
                  checked={picked.has(s.key)}
                  disabled={!has}
                  onChange={() => toggle(s.key)}
                />
                <span className="transfer-label">
                  {s.label}
                  <span className="transfer-count">
                    {has ? ` (${n})` : ' — not in this file'}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {/* A flow step names a saved request by id. Say it before the file is
            written or read, not only in the summary afterwards. */}
        {picked.has('flows') && !picked.has('tests') && (
          <p className="hint">
            Flows only: steps that run a saved request need that request to exist on the
            other side. Steps typed into the flow itself, and shell steps, travel whole.
          </p>
        )}

        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            className="btn-send"
            disabled={!chosen.length}
            onClick={() => onConfirm(chosen)}
          >
            {importing ? 'Import' : 'Export'}{' '}
            {!chosen.length ? 'nothing' : all ? 'everything' : chosen.map(
              (k) => SECTIONS.find((s) => s.key === k)!.label
            ).join(' + ')}
          </button>
        </div>
      </div>
    </div>
  );
}
