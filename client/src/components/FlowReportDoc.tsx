import React from 'react';
import {
  maskDetail, maskHeaders, maskJsonBody, maskUrl, reportVars, scrubber, secretValues,
} from '../report';
import { fmtSize, prettify } from '../util';
import type { Flow, StepReport, Vars } from '../types.ts';

// The run, written up for someone who was not at the keyboard: every step's
// verdict and the checks behind it, and under each one the whole call — the
// request as it went out, with this run's {{vars}} resolved into the url,
// headers and body, and the response that came back. Enough to check on paper
// that the right values were sent and the right thing returned, without
// opening the app. Secrets are covered unless the export was told to reveal
// them; long bodies are truncated the same way the run report truncates them.
//
// It is a document, not a panel — plain black on white, no theme, laid out for
// paper. On screen it is display:none. With `capture` it is shown off the edge
// of the page for html2pdf to rasterise into a download; @media print likewise
// hides the app and shows this, so Cmd-P on the page still prints it.
interface ReportDocProps {
  flow: Flow;
  report: {
    ok: boolean;
    durationMs: number;
    steps: StepReport[];
    vars: Vars;
    error?: string;
    oneStep?: string;
    startedAt?: string;
  };
  environmentName: string | null;
  // Whether tokens, passwords and cookies are printed as they ran. Off by
  // default — see report.ts.
  reveal: boolean;
  // Position the document off-screen and visible, so html2pdf has something to
  // measure. Without it the document stays display:none (print path only).
  capture?: boolean;
}

function when(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function duration(ms: number | undefined): string {
  if (ms == null) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export default function FlowReportDoc({ flow, report, environmentName, reveal, capture }: ReportDocProps) {
  const steps = report.steps || [];
  const skipped = steps.filter((s) => s.skipped);
  const ran = steps.filter((s) => !s.skipped);
  const failed = ran.filter((s) => !s.ok);
  const vars = reportVars(report.vars, reveal);
  // Every secret value the run captured, struck out of whatever text quotes it
  // back — an assertion's `got "…"` most of all, since the check that read the
  // value had no idea what it was holding.
  const scrub = scrubber(reveal
    ? []
    : secretValues([report.vars, ...steps.map((s) => s.extracted)]));

  // A one-step run answers for that step alone. Saying "all steps passed" over
  // the other rows' older results would be a lie on paper too — worse, since
  // paper outlives the screen that made it clear.
  const oneStep = report.oneStep
    ? steps.find((s) => s.id === report.oneStep)
    : undefined;

  return (
    <article className={capture ? 'print-report export-capture' : 'print-report'}>
      <header className="pr-head">
        <div className={`pr-verdict ${report.ok ? 'ok' : 'err'}`}>
          {report.ok ? 'PASSED' : 'FAILED'}
        </div>
        <h1>{flow.name || 'Untitled flow'}</h1>
        {oneStep && (
          <p className="pr-scope">
            One step only — “{oneStep.name}” — run on its own. The other steps below
            show whatever their last run said, which may be older.
          </p>
        )}
        {flow.description && <p className="pr-desc">{flow.description}</p>}
        <dl className="pr-facts">
          <div><dt>Ran</dt><dd>{when(report.startedAt)}</dd></div>
          <div><dt>Took</dt><dd>{duration(report.durationMs)}</dd></div>
          <div><dt>Environment</dt><dd>{environmentName || 'None'}</dd></div>
          <div>
            <dt>Steps</dt>
            <dd>
              {ran.length - failed.length} of {ran.length} passed
              {failed.length ? `, ${failed.length} failed` : ''}
              {skipped.length ? `, ${skipped.length} skipped` : ''}
            </dd>
          </div>
        </dl>
        {report.error && <p className="pr-error">{report.error}</p>}
      </header>

      {steps.length === 0 && <p className="pr-empty">This flow has no steps.</p>}

      <ol className="pr-steps">
        {steps.map((s, i) => {
          const shell = s.mode === 'shell';
          const mark = s.skipped ? '–' : s.ok ? '✓' : '✗';
          const cls = s.skipped ? 'skip' : s.ok ? 'ok' : 'err';
          // What actually went out and what came back, resolved — not what the
          // step is configured to send. On a report they can differ, and the
          // pair that ran is the pair being reported on.
          const req = s.request;
          const reqBody = req?.body
            ? maskJsonBody(prettify(req.body, req.headers), reveal) : '';
          const res = s.response;
          const resBody = res && res.bodyEncoding !== 'base64' && res.body
            ? maskJsonBody(prettify(res.body, res.headers), reveal) : '';
          return (
            <li key={s.id || i} className={`pr-step ${cls}`}>
              <div className="pr-step-head">
                <span className="pr-mark">{mark}</span>
                <span className="pr-step-name">{i + 1}. {s.name || `Step ${i + 1}`}</span>
                {s.always && <span className="pr-tag">teardown</span>}
              </div>

              {s.skipped
                ? <div className="pr-step-note">Skipped — {s.skipped}</div>
                : (
                  <>
                    {shell ? (
                      <div className="pr-io">
                        <div className="pr-io-label">Ran</div>
                        <div className="pr-step-what">$ {scrub(s.command || '')}</div>
                        {s.commandRaw && (
                          <div className="pr-step-note">as typed: {scrub(s.commandRaw)}</div>
                        )}
                        {s.cwd && <div className="pr-step-note">in {s.cwd}</div>}
                      </div>
                    ) : req && (
                      <div className="pr-io">
                        <div className="pr-io-label">Sent</div>
                        <div className="pr-step-what">
                          {req.method} {scrub(maskUrl(req.url, reveal))}
                        </div>
                        {Object.keys(req.headers || {}).length > 0 && (
                          <table className="pr-io-kv">
                            <tbody>
                              {maskHeaders(req.headers, reveal).map(([k, v]) => (
                                <tr key={k}><th>{k}</th><td>{scrub(v)}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {reqBody && <pre className="pr-io-body">{scrub(reqBody)}</pre>}
                        {req.bodyTruncated && (
                          <div className="pr-step-note">Sent body truncated for the report.</div>
                        )}
                        {req.form && req.form.length > 0 && (
                          <table className="pr-io-kv">
                            <tbody>
                              {req.form.map((f, k) => (
                                <tr key={k}>
                                  <th>{f.key}</th>
                                  <td>{f.file ? '(file)' : scrub(f.value || '')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                    <div className="pr-step-facts">
                      {shell
                        ? <>exit code {s.exitCode ?? '—'}</>
                        : s.status != null && <>{s.status} {s.statusText}</>}
                      {s.timeMs != null && <span className="pr-dot"> · {duration(s.timeMs)}</span>}
                    </div>
                    {shell ? (
                      s.shell && (
                        <div className="pr-io">
                          <div className="pr-io-label">Output</div>
                          {s.freshShell && (
                            <div className="pr-step-note">
                              Ran in a new shell — the one the earlier steps shared had gone.
                            </div>
                          )}
                          {s.shell.stdout
                            ? <pre className="pr-io-body">{scrub(s.shell.stdout)}</pre>
                            : <div className="pr-step-note">No output on stdout.</div>}
                          {s.shell.stderr && (
                            <pre className="pr-io-body pr-io-stderr">{scrub(s.shell.stderr)}</pre>
                          )}
                          {s.shell.truncated && (
                            <div className="pr-step-note">Output truncated for the report.</div>
                          )}
                        </div>
                      )
                    ) : res && (
                      <div className="pr-io">
                        <div className="pr-io-label">Response</div>
                        {Object.keys(res.headers || {}).length > 0 && (
                          <table className="pr-io-kv">
                            <tbody>
                              {maskHeaders(res.headers, reveal).map(([k, v]) => (
                                <tr key={k}><th>{k}</th><td>{scrub(v)}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {res.bodyEncoding === 'base64' ? (
                          <div className="pr-step-note">
                            Binary response ({fmtSize(res.size)}) — not kept in the run report.
                          </div>
                        ) : (
                          <>
                            <pre className="pr-io-body">{scrub(resBody) || '(empty body)'}</pre>
                            {res.truncated && (
                              <div className="pr-step-note">Body truncated for the report.</div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {s.error && (
                      <div className="pr-step-note pr-error">
                        {scrub(s.error)}{s.hint ? ` — ${scrub(s.hint)}` : ''}
                      </div>
                    )}
                    {!!(s.assertions || []).length && (
                      <ul className="pr-checks">
                        {(s.assertions || []).map((a, k) => (
                          <li key={k} className={a.ok ? 'ok' : 'err'}>
                            {a.ok ? '✓' : '✗'} {scrub(maskDetail(a.detail, reveal))}
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.script?.error && (
                      <div className="pr-step-note pr-error">Script: {scrub(s.script.error)}</div>
                    )}
                    {!!Object.keys(s.extracted || {}).length && (
                      <div className="pr-step-note">
                        Captured{' '}
                        {reportVars(s.extracted, reveal)
                          .map(([k, v]) => `${k}=${scrub(v)}`).join(', ')}
                      </div>
                    )}
                  </>
                )}
            </li>
          );
        })}
      </ol>

      {vars.length > 0 && (
        <section className="pr-vars">
          <h2>Values the run captured</h2>
          <table>
            <tbody>
              {vars.map(([k, v]) => (
                <tr key={k}><th>{k}</th><td>{scrub(v)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="pr-foot">
        {!reveal && <>Tokens, passwords and cookies are covered. </>}
        Written {when(undefined)} by testing-tool.
      </footer>
    </article>
  );
}
