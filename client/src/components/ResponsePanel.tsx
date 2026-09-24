import React, { useState } from 'react';
import HttpBodyView from './HttpBodyView.tsx';
import ShellOutputView from './ShellOutputView.tsx';
import { fmtSize } from '../util.ts';
import type { RunResponse, ScriptReport, ShellResponse } from '../types.ts';

function trunc(s: unknown, n = 48): string {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// A filename for the download, from Content-Disposition when the server sent
// one, else from the URL's last path segment, else a generic name.
function fileNameFor(headers: Record<string, string> | undefined): string {
  const cd = headers && (headers['content-disposition'] || headers['Content-Disposition']) || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m) return decodeURIComponent(m[1]!);
  return 'response';
}

function base64ToBlob(b64: string, type?: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

// What a script did, above whatever came back. Shared by the two panels below,
// which differ in everything else.
function ScriptResult({ scriptResult }: { scriptResult: ScriptReport | null | undefined }) {
  if (!scriptResult) return null;
  return (
    <div className={`script-result ${scriptResult.error ? 'err' : 'ok'}`}>
      {scriptResult.error
        ? `⚠ Script: ${scriptResult.error}`
        : `✓ Saved to environment: ${Object.entries(scriptResult.saved || {})
          .map(([k, v]) => `${k} = ${trunc(v)}`).join(', ')}`}
    </div>
  );
}

// What a shell test got back. No tabs: a command has an exit code and two
// streams, shown the way a flow's shell step shows them.
function ShellResult(
  { response, scriptResult, clear }:
  { response: ShellResponse; scriptResult: ScriptReport | null | undefined; clear: React.ReactNode },
) {
  const { exitCode, stdout, stderr } = response;
  return (
    <div className="response-panel">
      <div className="response-meta">
        <span className={`status ${exitCode === 0 ? 'ok' : 'err'}`}>exit {exitCode}</span>
        <span className="meta-item">{response.time} ms</span>
        <span className="meta-item">{fmtSize(response.size)}</span>
        {clear}
      </div>

      <ScriptResult scriptResult={scriptResult} />

      <div className="tab-body shell-output">
        <ShellOutputView stdout={stdout} stderr={stderr} codeClass="resp-code" />
      </div>
    </div>
  );
}

interface ResponsePanelProps {
  response: RunResponse | null | undefined;
  error: string | null | undefined;
  sending: boolean;
  scriptResult?: ScriptReport | null;
  busyText?: string;
  emptyText?: string;
  // Back to the empty panel: the last response, error and script result gone,
  // so what shows next is unmistakably from the next send.
  onClear?: () => void;
}

export default function ResponsePanel({
  response, error, sending, scriptResult, onClear,
  // A shell test is not sending anything, and the wait is the command running.
  busyText = 'Sending request…', emptyText = 'Response will appear here',
}: ResponsePanelProps) {
  // Which tab, kept here rather than in the body view: that view unmounts
  // while a request is in flight, and the tab you were on should survive it.
  const [tab, setTab] = useState('body');

  const http = response && response.kind !== 'shell' ? response : null;
  const isBinary = !!http && http.bodyEncoding === 'base64';

  const clear = onClear && (
    <button className="mini-text resp-clear" title="Clear the response" onClick={onClear}>Clear</button>
  );

  if (sending) return <div className="response-panel empty">{busyText}</div>;
  if (error) {
    return (
      <div className="response-panel empty err">
        <div>⚠ {error}</div>
        {clear}
      </div>
    );
  }
  if (!response) return <div className="response-panel empty">{emptyText}</div>;
  // A command's result is read nothing like a response, so it gets its own
  // panel rather than a status line pretending an exit code is an HTTP status.
  if (response.kind === 'shell') {
    return <ShellResult response={response} scriptResult={scriptResult} clear={clear} />;
  }

  const statusClass = response.status < 300 ? 'ok' : response.status < 400 ? 'warn' : 'err';
  const contentType = response.headers
    && (response.headers['content-type'] || response.headers['Content-Type']) || '';

  function download() {
    if (!http) return;
    const blob = isBinary
      ? base64ToBlob(http.body, contentType.split(';')[0])
      : new Blob([http.body], { type: contentType || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileNameFor(http.headers);
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="response-panel">
      <div className="response-meta">
        <span className={`status ${statusClass}`}>
          {response.status} {response.statusText}
        </span>
        <span className="meta-item">{response.time} ms</span>
        <span className="meta-item">{fmtSize(response.size)}</span>
        {clear}
      </div>

      <ScriptResult scriptResult={scriptResult} />

      <HttpBodyView
        body={response.body}
        headers={response.headers}
        binary={isBinary}
        codeClass="resp-code"
        tab={tab}
        onTab={setTab}
        actions={<button className="mini-text" onClick={download}>Download</button>}
        binaryNote={(
          <div className="binary-note">
            <p>
              Binary response ({contentType || 'unknown type'}, {fmtSize(response.size)}) —
              not shown as text because decoding it would corrupt the bytes.
            </p>
            <button className="btn-secondary" onClick={download}>Download</button>
          </div>
        )}
      />
    </div>
  );
}
