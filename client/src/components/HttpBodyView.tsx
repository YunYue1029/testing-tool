import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import CodeView from './CodeView.tsx';
import { prettify, isJsonText } from '../util.ts';

// An HTTP response's body and headers, as both the response panel and a flow
// step show them: a Body tab laid out to read with the raw text a click away,
// and a Headers tab. What differs between the two — how a binary body is
// explained, whether it can be downloaded, what to say under a body that was
// cut — comes in as props.
interface HttpBodyViewProps {
  body: string;
  headers: Record<string, string> | undefined;
  // The bytes never travelled as text (a download, an image).
  binary: boolean;
  // Shown in place of a binary body.
  binaryNote: ReactNode;
  // Which panel's code view: the response panel's fills its column, a step's
  // is capped.
  codeClass: string;
  // Buttons after Copy on the Body tab (Download).
  actions?: ReactNode;
  // Under the body: that it was cut for the report.
  note?: ReactNode;
  // Said in place of an empty body, where an empty box would say nothing.
  emptyHint?: string;
  // The tab, when the caller keeps it — the response panel unmounts this
  // view while a request is in flight, and the tab you were on should
  // survive that.
  tab?: string;
  onTab?: (tab: string) => void;
}

export default function HttpBodyView({
  body, headers, binary, binaryNote, codeClass, actions, note, emptyHint, tab: heldTab, onTab,
}: HttpBodyViewProps) {
  const [ownTab, setOwnTab] = useState('body');
  const tab = heldTab ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const pretty = useMemo(() => (binary ? '' : prettify(body)), [body, binary]);
  // Pretty or raw, JSON is JSON: the colouring and the folds apply to both.
  const jsonBody = useMemo(() => isJsonText(pretty), [pretty]);
  const shown = raw ? body : pretty;
  // Only worth offering when prettifying actually changed something.
  const canToggle = !binary && pretty !== body;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      alert('Could not copy — the browser blocked clipboard access.');
    }
  }

  return (
    <>
      <div className="tabs">
        <button className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>Body</button>
        <button className={tab === 'headers' ? 'active' : ''} onClick={() => setTab('headers')}>
          Headers ({Object.keys(headers || {}).length})
        </button>
        <span className="spacer" />
        {tab === 'body' && (!binary || actions) && (
          <div className="resp-actions">
            {canToggle && (
              <button className="mini-text" onClick={() => setRaw(!raw)}>{raw ? 'Pretty' : 'Raw'}</button>
            )}
            {!binary && (
              <button className="mini-text" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            )}
            {actions}
          </div>
        )}
      </div>

      <div className="tab-body">
        {tab === 'body' && (binary ? binaryNote : (
          <>
            {shown || !emptyHint
              ? <CodeView className={codeClass} value={shown} json={jsonBody} />
              : <p className="hint">{emptyHint}</p>}
            {note}
          </>
        ))}
        {tab === 'headers' && (
          <table className="headers-view">
            <tbody>
              {Object.entries(headers || {}).map(([k, v]) => (
                <tr key={k}><td className="hk">{k}</td><td className="hv">{String(v)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
