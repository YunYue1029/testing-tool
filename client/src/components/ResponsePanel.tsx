import React, { useState, useMemo } from 'react';
import { prettify, fmtSize } from '../util';
import type { ScriptReport } from '../../../server/types.ts';
import type { RunResponse, ShellResponse } from '../types.ts';

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
// streams, and stderr is where a command that failed explained itself — the
// first thing anyone looking at a red exit code wants, not something to go
// clicking for. The same shape a flow's shell step shows, for the same reason.
function ShellResult(
  { response, scriptResult }:
  { response: ShellResponse; scriptResult: ScriptReport | null | undefined },
) {
  const { exitCode, stdout, stderr } = response;
  return (
    <div className="response-panel">
      <div className="response-meta">
        <span className={`status ${exitCode === 0 ? 'ok' : 'err'}`}>exit {exitCode}</span>
        <span className="meta-item">{response.time} ms</span>
        <span className="meta-item">{fmtSize(response.size)}</span>
      </div>

      <ScriptResult scriptResult={scriptResult} />

      <div className="tab-body shell-output">
        {stdout ? (
          <>
            <div className="field-label">stdout</div>
            <pre className="response-body">{stdout}</pre>
          </>
        ) : <p className="hint">No output on stdout.</p>}
        {stderr && (
          <>
            <div className="field-label">stderr</div>
            <pre className="response-body shell-stderr">{stderr}</pre>
          </>
        )}
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
}

export default function ResponsePanel({
  response, error, sending, scriptResult,
  // A shell test is not sending anything, and the wait is the command running.
  busyText = 'Sending request…', emptyText = 'Response will appear here',
}: ResponsePanelProps) {
  const [tab, setTab] = useState('body');
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  // Both are computed before the early returns below, so a shell result — which
  // has no body to prettify — passes through them untouched on its way to its
  // own panel.
  const http = response && response.kind !== 'shell' ? response : null;
  const isBinary = !!http && http.bodyEncoding === 'base64';
  const pretty = useMemo(
    () => (http && !isBinary ? prettify(http.body, http.headers) : ''),
    [response, isBinary]
  );

  if (sending) return <div className="response-panel empty">{busyText}</div>;
  if (error) return <div className="response-panel empty err">⚠ {error}</div>;
  if (!response) return <div className="response-panel empty">{emptyText}</div>;
  // A command's result is read nothing like a response, so it gets its own
  // panel rather than a status line pretending an exit code is an HTTP status.
  if (response.kind === 'shell') {
    return <ShellResult response={response} scriptResult={scriptResult} />;
  }

  const statusClass = response.status < 300 ? 'ok' : response.status < 400 ? 'warn' : 'err';
  const contentType = response.headers
    && (response.headers['content-type'] || response.headers['Content-Type']) || '';
  const shown = raw ? response.body : pretty;
  // Only worth offering when prettifying actually changed something.
  const canToggle = !isBinary && pretty !== response.body;

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
    <div className="response-panel">
      <div className="response-meta">
        <span className={`status ${statusClass}`}>
          {response.status} {response.statusText}
        </span>
        <span className="meta-item">{response.time} ms</span>
        <span className="meta-item">{fmtSize(response.size)}</span>
      </div>

      <ScriptResult scriptResult={scriptResult} />

      <div className="tabs">
        <button className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>Body</button>
        <button className={tab === 'headers' ? 'active' : ''} onClick={() => setTab('headers')}>
          Headers ({Object.keys(response.headers || {}).length})
        </button>
        <span className="spacer" />
        {tab === 'body' && (
          <div className="resp-actions">
            {canToggle && (
              <button className="mini-text" onClick={() => setRaw(!raw)}>
                {raw ? 'Pretty' : 'Raw'}
              </button>
            )}
            {!isBinary && (
              <button className="mini-text" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            )}
            <button className="mini-text" onClick={download}>Download</button>
          </div>
        )}
      </div>

      <div className="tab-body">
        {tab === 'body' && (isBinary ? (
          <div className="binary-note">
            <p>
              Binary response ({contentType || 'unknown type'}, {fmtSize(response.size)}) —
              not shown as text because decoding it would corrupt the bytes.
            </p>
            <button className="btn-secondary" onClick={download}>Download</button>
          </div>
        ) : (
          <pre className="response-body">{shown}</pre>
        ))}
        {tab === 'headers' && (
          <table className="headers-view">
            <tbody>
              {Object.entries(response.headers || {}).map(([k, v]) => (
                <tr key={k}><td className="hk">{k}</td><td className="hv">{String(v)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
