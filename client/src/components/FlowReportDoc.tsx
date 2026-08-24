import React from 'react';
import { maskDetail, maskUrl, reportVars, scrubber, secretValues } from '../report';
import type { Flow, StepReport, Vars } from '../types.ts';

// The run, written up for someone who was not at the keyboard. It reports what
// each step proved, not what it sent: a reader deciding whether the build is
// good needs the verdict and the checks behind it, and pasting every request
// and response body in would bury both. The screen still holds all of that,
// for the person who has to go and fix it.
//
// It is a document, not a panel — plain black on white, no theme, laid out for
// paper. On screen it is display:none; @media print hides the app and shows
// this, which is what turns the browser's print dialog into "save a PDF".
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
}

function when(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function duration(ms: number | undefined): string {
  if (ms == null) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export default function FlowReportDoc({ flow, report, environmentName, reveal }: ReportDocProps) {
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
    <article className="print-report">
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
          // What actually went out, resolved — not what the step is configured
          // to send. On a report they can differ, and the one that ran is the
          // one being reported on.
          const what = shell
            ? scrub(s.command || '')
            : s.request && `${s.request.method} ${scrub(maskUrl(s.request.url, reveal))}`;
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
                    {what && <div className="pr-step-what">{shell ? `$ ${what}` : what}</div>}
                    <div className="pr-step-facts">
                      {shell
                        ? <>exit code {s.exitCode ?? '—'}</>
                        : s.status != null && <>{s.status} {s.statusText}</>}
                      {s.timeMs != null && <span className="pr-dot"> · {duration(s.timeMs)}</span>}
                    </div>
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
