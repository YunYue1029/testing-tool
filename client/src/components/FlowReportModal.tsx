import React, { useState } from 'react';
import HelpTip from './HelpTip';

// Turning the last run into something you can send someone. Answering the one
// question here — whether the secrets the run used are written into the file —
// saves "<flow name>.pdf" straight to your downloads. No print dialog, no
// filename to type, no folder to pick.
interface FlowReportModalProps {
  flowName: string;
  onExport: (reveal: boolean) => void;
  onCancel: () => void;
}

export default function FlowReportModal({ flowName, onExport, onCancel }: FlowReportModalProps) {
  const [reveal, setReveal] = useState(false);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>
          Export report
          <HelpTip>
            Saves a PDF named after the flow straight to your downloads folder.
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
          /> write secrets into the file as they ran
        </label>
        <p className="hint">
          {reveal
            ? 'Tokens, passwords and cookies will be written in full. Fine for a report that stays in the room.'
            : 'Tokens, passwords and cookies are covered with dots. Safe to forward.'}
        </p>

        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-send" onClick={() => onExport(reveal)}>Download PDF</button>
        </div>
      </div>
    </div>
  );
}
