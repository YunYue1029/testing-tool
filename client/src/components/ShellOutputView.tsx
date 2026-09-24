import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import CodeView from './CodeView.tsx';
import { prettify, isJsonText } from '../util.ts';

// What a command wrote, as both a shell test's panel and a flow's shell step
// show it. stderr sits under stdout rather than behind a tab: a command that
// failed usually explained itself there, and that is the first thing anyone
// reading a red exit code wants. A command that printed JSON — a curl,
// mostly — gets it laid out like a response body would be, with the raw
// stream a click away.
interface ShellOutputViewProps {
  stdout: string;
  stderr: string;
  // Which panel's code view: the response panel's fills its column, a step's
  // is capped.
  codeClass: string;
  // Under the streams: that they were cut for the report.
  note?: ReactNode;
}

export default function ShellOutputView({ stdout, stderr, codeClass, note }: ShellOutputViewProps) {
  const [raw, setRaw] = useState(false);
  const pretty = useMemo(() => prettify(stdout || ''), [stdout]);
  const shown = raw ? stdout : pretty;
  return (
    <>
      {stdout ? (
        <>
          <div className="field-label stream-label">
            stdout
            {pretty !== stdout && (
              <button className="mini-text" onClick={() => setRaw(!raw)}>{raw ? 'Pretty' : 'Raw'}</button>
            )}
          </div>
          <CodeView className={codeClass} value={shown} json={isJsonText(shown)} />
        </>
      ) : <p className="hint">No output on stdout.</p>}
      {stderr && (
        <>
          <div className="field-label">stderr</div>
          <CodeView className={`${codeClass} shell-stderr`} value={stderr} />
        </>
      )}
      {note}
    </>
  );
}
