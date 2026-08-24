import React, { useState } from 'react';
import HelpTip from './HelpTip';

// Turning the last run into something you can send someone. The report itself
// is printed by the browser — "Destination: Save as PDF" in the print dialog —
// which is why this asks nothing about paper: the one decision that is ours to
// make is whether the secrets the run used are printed with it.
interface FlowReportModalProps {
  flowName: string;
  onPrint: (reveal: boolean) => void;
  onCancel: () => void;
}

export default function FlowReportModal({ flowName, onPrint, onCancel }: FlowReportModalProps) {
  const [reveal, setReveal] = useState(false);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>
          Export report
          <HelpTip>
            Opens your browser’s print dialog. Choose “Save as PDF” as the destination
            to get a file you can send on.
          </HelpTip>
        </h3>

        <p className="hint">
          The last run of <strong>{flowName || 'this flow'}</strong>: what each step
          proved, and the checks behind it. Request and response bodies stay on the
          screen — a report is for the reader deciding whether this is good, not for
          the person who has to go and fix it.
        </p>

        <label className="report-secrets" title="Bearer tokens, passwords, cookies and anything captured under a name like token or secret">
          <input
            type="checkbox"
            checked={reveal}
            onChange={(e) => setReveal(e.target.checked)}
          /> print secrets as they ran
        </label>
        <p className="hint">
          {reveal
            ? 'Tokens, passwords and cookies will be printed in full. Fine for a report that stays in the room.'
            : 'Tokens, passwords and cookies are covered with dots. Safe to forward.'}
        </p>

        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-send" onClick={() => onPrint(reveal)}>Print…</button>
        </div>
      </div>
    </div>
  );
}
