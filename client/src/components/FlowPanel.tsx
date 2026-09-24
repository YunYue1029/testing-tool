import React, { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconPlus, IconClose, IconPencil, IconPlay } from './Icons';
import AddStepModal from './AddStepModal';
import StepEditModal from './StepEditModal';
import FlowReportModal from './FlowReportModal';
import FlowReportDoc from './FlowReportDoc';
import RequestVarsEditor from './RequestVarsEditor';
import {
  newId, prettify, fmtSize, emptyInlineRequest, fitToContent, flowUsedVarNames,
  applyCollectionBaseUrl, buildUrl, composeUrl, requestVars, substitute,
} from '../util';
import type {
  Collection, Flow, FlowShell, InlineRequest, Step, StepReport, Vars,
} from '../types.ts';

// A flow report as the panel receives it: the server's, plus the two things
// only the panel knows — a run that failed before it started, and which single
// step a one-step run covered.
interface PanelReport {
  ok: boolean;
  durationMs: number;
  steps: StepReport[];
  vars: Record<string, string>;
  error?: string;
  oneStep?: string;
  // When the run started, as the server stamped it. Only the printed report
  // asks — on screen the run you are looking at is the one that just happened.
  startedAt?: string;
}

interface FlowPanelProps {
  flow: Flow;
  collections: Collection[];
  onChange: (flow: Flow) => void;
  onRun: () => void;
  onRunStep: (stepId: string) => void;
  onDelete: () => void;
  running: boolean;
  runningStep: string | null;
  report: PanelReport | null;
  // Which environment the run resolved its {{vars}} against. Only the printed
  // report asks — a reader who was not here cannot tell staging from local.
  environmentName: string | null;
  // The active environment's values, so the vars editor can say which of the
  // flow's own override it and which tokens nothing defines.
  envVars: Vars;
}

// Its own type, like the sidebar's two: it says a dragover is one of ours, and
// keeps a file dragged in from the desktop from looking like a step.
const STEP_DRAG_TYPE = 'application/x-testing-tool-step';

function emptyStep(): Step {
  return {
    // Direct, because a step added by name alone has nothing picked yet and
    // Direct is the one you can finish by typing — the other two need a
    // request chosen or a command written before they run at all.
    id: newId(), mode: 'inline', collectionId: null, requestId: null,
    request: emptyInlineRequest(),
    command: '',
    // Spelled out rather than left off: the store normalises a missing cwd to
    // '' anyway, and every reader already treats the two the same.
    cwd: '',
    name: '', enabled: true, always: false, extract: [], assert: [], script: '',
  };
}

// What the step sent, shown above what came back. The run has to keep this: the
// url, body and command all had this run's variables resolved into them, so the
// step as it is stored no longer says what went out — and a result you can't
// see the call for is half a report. Opening a step should answer "what did it
// send, what came back" without a trip through the edit dialog.
function StepSent({ rep }: { rep: StepReport }) {
  const [headers, setHeaders] = useState(false);
  const req = rep.request;

  if (rep.mode === 'shell') {
    return (
      <div className="step-sent">
        <div className="step-shell-cmd"><code>{rep.command || '(no command)'}</code></div>
        {/* The line as typed, when a {{var}} made it differ from the one above:
            the resolved command is what ran, but the template is what is stored
            on the step and what you would go back and change. */}
        {rep.commandRaw && (
          <div className="step-sent-note">as typed <code>{rep.commandRaw}</code></div>
        )}
        {/* The same command means different things in two checkouts. */}
        {rep.cwd && <div className="step-sent-note">in <code>{rep.cwd}</code></div>}
      </div>
    );
  }

  if (!req) return null;
  const body = prettify(req.body || '', req.headers);
  const count = Object.keys(req.headers || {}).length;
  return (
    <div className="step-sent">
      <div className="step-sent-line">
        <span className="step-summary-lead">{req.method}</span>
        <span className="step-sent-url" title={req.url}>{req.url}</span>
        {/* Behind a click, unlike the body: the headers that went out are mostly
            the collection's auth and a Content-Type, and they would push what
            was actually posted off the screen. */}
        {count > 0 && (
          <button
            className="mini-text"
            title="The headers this step sent, auth included"
            onClick={() => setHeaders(!headers)}
          >{headers ? 'Hide' : `${count} header${count === 1 ? '' : 's'}`}</button>
        )}
      </div>
      {headers && (
        <table className="headers-view">
          <tbody>
            {Object.entries(req.headers).map(([k, v]) => (
              <tr key={k}><td className="hk">{k}</td><td className="hv">{v}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {body && <pre className="step-body step-sent-body">{body}</pre>}
      {req.bodyTruncated && <p className="hint">Sent body truncated for the report.</p>}
      {req.form && (
        <table className="headers-view">
          <tbody>
            {req.form.map((f, k) => (
              <tr key={k}>
                <td className="hk">{f.key}</td>
                <td className="hv">{f.file ? '(file)' : f.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// What a shell step got back. stderr sits beside stdout rather than behind a
// tab: a command that failed usually explained itself there, and that is the
// first thing anyone reading a red step wants.
function StepShellOutput({ rep }: { rep: StepReport }) {
  const { stdout, stderr, truncated } = rep.shell!;
  return (
    <div className="step-response">
      <StepSent rep={rep} />
      {/* Worth saying because it changes what this command could have seen:
          something killed the shell the run was sharing, so it started in a new
          one with none of what the steps before it had set up. */}
      {rep.freshShell && (
        <p className="hint">Ran in a new shell — the one the earlier steps shared had gone.</p>
      )}
      {stdout ? (
        <>
          <div className="field-label">stdout</div>
          <pre className="step-body step-resp-body">{stdout}</pre>
        </>
      ) : <p className="hint">No output on stdout.</p>}
      {stderr && (
        <>
          <div className="field-label">stderr</div>
          <pre className="step-body step-resp-body step-stderr">{stderr}</pre>
        </>
      )}
      {truncated && <p className="hint">Output truncated for the report.</p>}
    </div>
  );
}

function statusClass(status: number | undefined): string {
  if (status == null) return '';
  return status < 300 ? 'ok' : status < 400 ? 'warn' : 'err';
}

// What one step actually got back. A flow's whole point is that the calls
// happened in this order with these values, so re-sending the request on its
// own no longer reproduces what you want to look at — the run has to keep it.
function StepResponse({ rep }: { rep: StepReport }) {
  const [tab, setTab] = useState('body');
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const res = rep.response!;
  const pretty = useMemo(() => prettify(res.body, res.headers), [res]);
  const binary = res.bodyEncoding === 'base64';
  const shown = raw ? res.body : pretty;

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
    <div className="step-response">
      {/* Above the verdict, in the order it happened: the call, then what it
          got. The url used to sit in the meta line below, and now travels with
          the rest of what went out. */}
      <StepSent rep={rep} />
      <div className="step-response-meta">
        <span className={`status ${statusClass(rep.status)}`}>{rep.status} {rep.statusText}</span>
        <span className="meta-item">{rep.timeMs} ms</span>
        <span className="meta-item">{fmtSize(res.size)}</span>
      </div>

      {/* Every assertion, not only the broken ones: on a passing step this is
          the evidence, and on a failing one it says what did hold. */}
      {(rep.assertions || []).length > 0 && (
        <div className="step-checks">
          {rep.assertions!.map((a, k) => (
            <div key={k} className={a.ok ? 'ok' : 'err'}>{a.ok ? '✓' : '✗'} {a.detail}</div>
          ))}
        </div>
      )}
      {rep.script && rep.script.error && (
        <div className="step-checks"><div className="err">✗ script: {rep.script.error}</div></div>
      )}
      {rep.extracted && Object.keys(rep.extracted).length > 0 && (
        <div className="step-extracted">
          captured {Object.entries(rep.extracted).map(([k, v]) => `${k} = ${v}`).join(', ')}
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>Body</button>
        <button className={tab === 'headers' ? 'active' : ''} onClick={() => setTab('headers')}>
          Headers ({Object.keys(res.headers || {}).length})
        </button>
        <span className="spacer" />
        {tab === 'body' && !binary && (
          <div className="resp-actions">
            {pretty !== res.body && (
              <button className="mini-text" onClick={() => setRaw(!raw)}>{raw ? 'Pretty' : 'Raw'}</button>
            )}
            <button className="mini-text" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        )}
      </div>

      <div className="tab-body">
        {tab === 'body' && (binary ? (
          // The bytes never travelled: a report carrying a few megabytes of
          // base64 per step would make every run slow to look at.
          <p className="hint">
            Binary response ({fmtSize(res.size)}) — not kept in the run report.
            Open the request itself to download it.
          </p>
        ) : (
          <>
            <pre className="step-body step-resp-body">{shown || '(empty body)'}</pre>
            {res.truncated && <p className="hint">Body truncated for the report.</p>}
          </>
        ))}
        {tab === 'headers' && (
          <table className="headers-view">
            <tbody>
              {Object.entries(res.headers || {}).map(([k, v]) => (
                <tr key={k}><td className="hk">{k}</td><td className="hv">{v}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// The flow's name as a download filename: drop what a filesystem won't take,
// keep it to one line and a sane length, and never hand back an empty string.
function pdfName(name: string): string {
  const clean = (name || '')
    .replace(/[\\/:*?"<>|]+/g, '')   // characters a filesystem refuses
    .replace(/\s+/g, ' ')            // one line, single-spaced
    .trim()
    .slice(0, 120)
    .replace(/[.\s]+$/, '');         // no trailing dot or space
  return clean || 'flow-report';
}

// One flow: an ordered list of requests run together, with the values each step
// hands to the next and the checks on what came back.
export default function FlowPanel({
  flow, collections, onChange, onRun, onRunStep, onDelete, running, runningStep, report,
  environmentName, envVars,
}: FlowPanelProps) {
  const [openStep, setOpenStep] = useState<string | null>(null); // step id whose detail is expanded
  const [adding, setAdding] = useState(false); // the "add step" dialog is up
  const [varsOpen, setVarsOpen] = useState(false); // the flow's own vars are showing
  const varCount = (flow.vars || []).filter((r) => r.key).length;
  const usedVars = useMemo(() => flowUsedVarNames(flow, collections), [flow, collections]);
  // Which step the detail panel shows. A run moves it to the first step that
  // failed — that is the one you came to read — and otherwise it stays where
  // you left it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    const broke = report && report.steps.find((s) => !s.ok && !s.skipped);
    if (broke) setSelectedId(broke.id);
  }, [report]);

  // Writing the run up for someone who was not here. The dialog asks one
  // question — whether to print the secrets the run used — and answering it
  // renders the document off-screen, turns it into "<flow name>.pdf" and drops
  // that straight into the browser's downloads. No print dialog, no filename to
  // type, no folder to choose.
  const [exporting, setExporting] = useState(false);
  const [capturing, setCapturing] = useState<{ reveal: boolean } | null>(null);
  // From an effect, not the click: the portal mounts the document this render,
  // and html2pdf can only read it once it is actually in the page.
  useEffect(() => {
    if (!capturing) return undefined;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      const el = document.querySelector('.print-report.export-capture');
      if (el) {
        try {
          const { default: html2pdf } = await import('html2pdf.js');
          await html2pdf().set({
            filename: `${pdfName(flow.name)}.pdf`,
            // The off-screen document already carries the page margin as its
            // own padding, so the PDF itself gets none.
            margin: 0,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, backgroundColor: '#ffffff' },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            // Honour `break-inside: avoid` on a step so it is not cut in half.
            pagebreak: { mode: ['css', 'legacy'] },
          }).from(el).save();
        } catch (err) {
          console.error('PDF export failed', err);
        }
      }
      if (!cancelled) setCapturing(null);
    }, 0);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [capturing, flow.name]);

  // The description sizes itself to its text, but the ref callback below only
  // fires on mount — switching flows reuses the same textarea, so without this
  // a short description would keep the height the last flow's long one left
  // behind, and an empty one would open as a block of blank.
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const hasDesc = !!(flow.description || '').trim();
  // A new flow starts folded, whatever the last one was left at: the fold is
  // there to keep the steps in view, and arriving somewhere new is when that
  // matters most.
  useEffect(() => { setDescOpen(false); }, [flow.id]);
  useLayoutEffect(() => {
    fitToContent(descRef.current);
  }, [flow.id, flow.description, descOpen]);

  // Unfolding by clicking the line puts the cursor in it. It is an editable
  // field either way, and a click on text you can type into that leaves you
  // unable to type is its own small puzzle.
  function openDesc() {
    setDescOpen(true);
    requestAnimationFrame(() => descRef.current?.focus());
  }

  const setStep = (id: string, patch: Partial<Step>) => onChange({
    ...flow,
    steps: flow.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  });

  // ---- Reordering steps by dragging them ----
  // The order IS the flow — login before create, delete last — so it is set the
  // way the sidebar files a flow: by dragging. The grab handle is the step
  // number rather than the whole row, because the row carries the name input and
  // a draggable ancestor turns selecting text in it into a drag.
  const [dragStepId, setDragStepId] = useState<string | null>(null); // fades the row in flight
  // The same id where a drop handler can read it: the first dragover can arrive
  // before React has committed the dragstart, and getData stays sealed until the
  // drop, so state alone would run a frame behind.
  const dragStepRef = useRef<string | null>(null);
  // Where it would land: an index into the current list, so `n` means "above
  // step n" and steps.length means "at the end". One line, never two for the
  // same gap.
  const [dropAt, setDropAt] = useState<number | null>(null);

  const draggingStep = (e: React.DragEvent) => e.dataTransfer.types.includes(STEP_DRAG_TYPE);

  function endDrag() {
    dragStepRef.current = null;
    setDragStepId(null);
    setDropAt(null);
  }

  // Above or below the step under the cursor, decided on its head rather than
  // its whole box: a step with its response open is tall, and its midpoint would
  // sit somewhere down in the response body.
  function stepDragOver(e: React.DragEvent, i: number) {
    if (!draggingStep(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const head = e.currentTarget.querySelector('.flow-step-head') || e.currentTarget;
    const box = head.getBoundingClientRect();
    setDropAt(e.clientY < box.top + box.height / 2 ? i : i + 1);
  }

  // `at` is an index into the list as it stands, with the dragged step still in
  // it — so removing it first shifts every later target down by one.
  function dropStep(id: string, at: number) {
    const steps = flow.steps.slice();
    const from = steps.findIndex((s) => s.id === id);
    if (from < 0 || at == null) return;
    const to = at > from ? at - 1 : at;
    if (to === from) return;
    const [moved] = steps.splice(from, 1);
    steps.splice(to, 0, moved);
    onChange({ ...flow, steps });
  }

  // What the ↑↓ buttons used to do, still on the handle: dragging is the way in
  // with a mouse, and this keeps the same move reachable from the keyboard.
  function move(i: number, delta: number) {
    const steps = flow.steps.slice();
    const j = i + delta;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    onChange({ ...flow, steps });
  }

  // What to call a step when asking about it, named after the thing it actually
  // runs. A saved step has to be looked up: its own `request` holds the inline
  // one, which the panel keeps across a mode switch, so reading the url here
  // would name a call this step does not make.
  const stepLabel = (step: Step, i: number) => {
    let what;
    if (step.mode === 'shell') what = step.command;
    else if (step.mode === 'inline') what = (step.request || ({} as Partial<InlineRequest>)).url;
    else {
      const r = savedFor(step);
      what = r && (r.name || ('url' in r ? r.url : '') || ('command' in r ? r.command : ''));
    }
    return step.name || what || `Step ${i + 1}`;
  };

  // The saved test a step points at, or null — a step in Saved mode may be
  // pointing at a request or at a shell test, and several things below read
  // differently depending on which.
  function savedFor(step: Step) {
    if ((step.mode || 'saved') !== 'saved' || !step.requestId) return null;
    const c = collections.find((x) => x.id === step.collectionId);
    return (c && (c.requests || []).find((x) => x.id === step.requestId)) || null;
  }

  // Does anything in this flow run a command — typed into a step, or saved as a
  // shell test it points at? That is what the shell settings below are for.
  const runsCommands = (steps: Step[]) => steps.some((s) => {
    if (s.mode === 'shell') return true;
    const r = savedFor(s);
    return !!r && r.kind === 'shell';
  });

  // One line saying what the step sends, in the shape each kind is read in: a
  // saved request by its name under its collection, a typed one by method and
  // url, a command by the command. `warn` means it would not run as it stands —
  // worth seeing without opening anything.
  const stepSummary = (step: Step) => {
    if (step.mode === 'shell') {
      return step.command
        ? { lead: '$', what: step.command }
        : { lead: '$', what: 'No command yet', warn: true };
    }
    if (step.mode === 'inline') {
      const r = step.request || ({} as Partial<InlineRequest>);
      const col = collections.find((x) => x.id === step.collectionId);
      return r.url
        ? { lead: r.method || 'GET', what: r.url, where: col && col.name }
        : { lead: r.method || 'GET', what: 'No URL yet', warn: true };
    }
    const col = collections.find((x) => x.id === step.collectionId);
    const r = col && (col.requests || []).find((x) => x.id === step.requestId);
    if (!r) return { what: 'No request picked', warn: true };
    // A saved test that runs a command reads as one: the same $ a typed-in
    // command gets, since that is what the step will do.
    if (r.kind === 'shell') {
      return { lead: '$', what: r.name || r.command, where: col.name };
    }
    return { lead: r.method, what: r.name || r.url, where: col.name };
  };

  // Where a step's request would actually go, built by the functions the server
  // sends with and from the same layers in the same order: the environment,
  // the collection's base url, a saved request's own values, the flow's vars,
  // then what the last run captured — so {{project_id}} reads as the id it was
  // last time. A token nothing defines yet is left as written. Null for a
  // command, or a step with nothing to send.
  const resolvedUrl = (step: Step): { url: string; template: string } | null => {
    if (step.mode === 'shell') return null;
    const col = collections.find((x) => x.id === step.collectionId) || null;
    const saved = step.mode === 'inline' ? null : savedFor(step);
    if (step.mode !== 'inline' && (!saved || saved.kind === 'shell')) return null;
    const vars = {
      ...applyCollectionBaseUrl(envVars, col),
      ...(saved ? requestVars(saved) : {}),
      ...requestVars(flow),
      ...(report ? report.vars : {}),
    };
    // An override replaces the whole url, unexpanded, exactly as runRequest does.
    if (step.overrides && step.overrides.url != null) {
      return { url: substitute(step.overrides.url, vars), template: step.overrides.url };
    }
    if (step.mode === 'inline') {
      const r = step.request;
      if (!r || !r.url) return null;
      return { url: buildUrl(composeUrl([], null, r.url), r.params, vars), template: r.url };
    }
    if (!saved || saved.kind === 'shell' || !saved.url) return null;
    return {
      url: buildUrl(composeUrl(col ? col.folders || [] : [], saved.folderId, saved.url), saved.params, vars),
      template: saved.url,
    };
  };

  // A node has room for the part of a url that differs from step to step; the
  // host is the same all the way down the chain and is on the detail anyway.
  // Left whole when it will not parse — a host still written as a {{token}}.
  const urlPath = (u: string) => {
    try {
      const p = new URL(u);
      return `${p.pathname}${p.search}`;
    } catch {
      return u;
    }
  };

  // Ask first, as every other delete in the app does: the flow saves itself a
  // moment after this, and a step can carry extractions, assertions and a
  // script that took longer to write than the request did.
  function removeStep(step: Step, i: number) {
    if (!confirm(`Remove "${stepLabel(step, i)}" from this flow?`)) return;
    onChange({ ...flow, steps: flow.steps.filter((s) => s.id !== step.id) });
  }

  // The dialog only asks for a name; the step's shape is this panel's business,
  // so it builds an empty one here for the pencil to fill in.
  function addStep(draft: Partial<Step>) {
    const step: Step = {
      ...emptyStep(),
      name: draft.name || '',
      // A flow almost always stays within one collection, so the last step
      // already answered this — carrying it over means a Direct step's
      // {{dy_url}} resolves without a second visit to say where it points.
      collectionId: [...flow.steps].reverse().find((s) => s.collectionId)?.collectionId || null,
    };
    onChange({ ...flow, steps: [...flow.steps, step] });
    setAdding(false);
  }

  const stepReport = (id: string) => (report ? report.steps.find((s) => s.id === id) : null);

  // What this flow's commands run in. Absent on a flow saved before there was
  // anything to say, and absent means one session — the same shell throughout,
  // which is what someone writing a second command expects of the first.
  const shell = flow.shell || {};
  const oneShell = shell.session !== false;
  const hasShellStep = runsCommands(flow.steps);
  const setShell = (patch: Partial<FlowShell>) => onChange({ ...flow, shell: { ...shell, ...patch } });

  // A shell step keeps its output under `shell` rather than `response`, but it
  // opens and closes the same way.
  const hasOutput = (rep: StepReport | null | undefined) => !!(rep && (rep.response || rep.shell));
  const selected = flow.steps.find((st) => st.id === selectedId) || flow.steps[0] || null;

  // What changes when a step runs, shown wherever the step is: on its node and
  // at the top of its detail. Only the flags that are on, so one always means
  // something.
  const stepFlags = (step: Step) => {
    const conds = (step.when || []).filter((c) => c.var);
    if (!step.always && step.enabled !== false && !conds.length) return null;
    return (
      <div className="node-flags">
        {step.always && (
          <span className="step-flag" title="Runs even after an earlier step failed">teardown</span>
        )}
        {step.enabled === false && (
          <span className="step-flag off" title="Skipped — this step is disabled">disabled</span>
        )}
        {conds.length > 0 && (
          <span className="step-flag cond" title="Runs only when this holds; skipped otherwise">
            if {conds.map((c) => (
              `${c.var} ${c.op || 'eq'}${['exists', 'missing'].includes(c.op || 'eq') ? '' : ` ${c.value || ''}`}`
            )).join(' and ')}
          </span>
        )}
      </div>
    );
  };

  const resultBadge = (rep: StepReport | null | undefined) => rep && (
    <span className={`step-result ${
      rep.skipped ? '' : rep.shell ? (rep.exitCode === 0 ? 'ok' : 'err') : statusClass(rep.status)}`}
    >
      {rep.skipped ? 'skipped' : rep.shell ? `exit ${rep.exitCode}` : rep.status}
      {rep.timeMs != null && ` · ${rep.timeMs}ms`}
    </span>
  );

  return (
    <div className="flow-panel">
      <div className="flow-head">
        <input
          className="flow-name"
          value={flow.name}
          placeholder="Flow name"
          onChange={(e) => onChange({ ...flow, name: e.target.value })}
        />
        <button className="btn-send" onClick={onRun} disabled={running}>
          {running ? 'Running…' : 'Run flow'}
        </button>
        {/* Up here with the other whole-flow controls: adding a step should not
            mean scrolling past the ones already there. Delete keeps the far
            edge — the row's one destructive button, hardest to hit by accident. */}
        <button
          className="btn-secondary add-step"
          onClick={() => setAdding(true)}
        ><IconPlus /> Add step</button>
        <button className="btn-secondary" onClick={onDelete}>Delete</button>
      </div>

      {/* Under the name, indented to line up with it. A flow is read long after
          it was written, usually by someone deciding whether it is the one that
          covers the thing they just broke — and a name has no room to answer
          that. Empty it stays one quiet line, so a flow that needs no note is
          not made to carry one.

          Folded to a single line until asked for. The steps are what the panel
          is for, and a description written to answer "is this the one?" answers
          it in its first few words — the rest is for the reader who has decided
          it is. Collapsed it is a div rather than the textarea, because that is
          the only way to end a clipped line in an ellipsis and so admit there
          is more. */}
      <div className="flow-desc">
        {hasDesc && (
          <button
            className={`caret desc-caret ${descOpen ? 'open' : ''}`}
            title={descOpen ? 'Fold the description back to one line' : 'Read the whole description'}
            onClick={() => setDescOpen((open) => !open)}
          >▸</button>
        )}
        {hasDesc && !descOpen ? (
          <div
            className="flow-description collapsed"
            title="Read the whole description"
            onClick={openDesc}
          >{flow.description}</div>
        ) : (
          <textarea
            className="flow-description"
            value={flow.description || ''}
            placeholder="What this flow proves — the case it covers, and anything it assumes"
            rows={1}
            ref={descRef}
            onChange={(e) => {
              fitToContent(e.target);
              onChange({ ...flow, description: e.target.value });
            }}
          />
        )}
      </div>

      {/* Folded to a count by default: the steps are what a flow is read for,
          and its inputs are set once and then left alone. */}
      <div className="flow-vars">
        <button
          className={`flow-vars-toggle ${varsOpen ? 'open' : ''}`}
          onClick={() => setVarsOpen((open) => !open)}
        >
          <span className={`caret ${varsOpen ? 'open' : ''}`}>▸</span> Variables
          {varCount > 0 && <span className="hint-inline"> · {varCount}</span>}
        </button>
        {varsOpen && (
          <RequestVarsEditor
            rows={flow.vars || []}
            used={usedVars}
            envVars={envVars}
            onChange={(vars) => onChange({ ...flow, vars })}
            title="Flow variables"
            help={(
              <>
                Values this flow runs with — they override the active environment and a
                saved request&apos;s own values, and a step that captures the same name
                overrides them. An input only this flow needs belongs here rather than in
                an environment.
              </>
            )}
          />
        )}
      </div>

      {/* Only once there is a command to run: a flow of pure HTTP has no shell,
          and a row asking about one would be a setting for nothing. */}
      {hasShellStep && (
        <div className="flow-shell-bar">
          <label title={'One shell for every command in this flow, so a cd, an export or a sourced '
            + 'env reaches the steps after it. Unchecked, each command gets a shell of its own and '
            + 'starts from nothing.'}>
            <input
              type="checkbox"
              checked={oneShell}
              onChange={(e) => setShell({ session: e.target.checked })}
            /> one shell for the whole run
          </label>
          <input
            className="flow-shell-cwd"
            value={shell.cwd || ''}
            spellCheck={false}
            placeholder="Working directory — the server’s own unless you say"
            title={oneShell
              ? 'Where the shell starts. A step that names its own directory cds there, and stays.'
              : 'Where each command runs, unless the step names its own.'}
            onChange={(e) => setShell({ cwd: e.target.value })}
          />
        </div>
      )}

      {report && (
        // A flow with no steps passes vacuously; saying so beats "all steps
        // passed" over a run that did nothing.
        <div className={`flow-summary ${report.steps.length === 0 ? 'none' : report.ok ? 'ok' : 'err'}`}>
          {/* A single step's run answers for that step only — saying "all steps
              passed" over the other rows' older results would be a lie. */}
          {report.oneStep
            ? `${report.ok ? '✓' : '✗'} Step ${
              flow.steps.findIndex((s) => s.id === report.oneStep) + 1} ${report.ok ? 'passed' : 'failed'} — run on its own`
            : report.steps.length === 0
              ? 'Nothing to run — this flow has no steps yet'
              : report.ok ? '✓ All steps passed' : '✗ Flow failed'}
          <span className="hint-inline"> · {report.durationMs} ms</span>
          {/* The verdict and what it took, and nothing else: what a run
              captured is on each step's own row, and in the report in full —
              listing a dozen tokens here only wrapped the bar onto four lines.
              The button lives on this bar rather than up with Run because
              there is nothing to report until a run has happened. */}
          <button
            className="btn-secondary report-export"
            title="Write this run up as a report — download it as a PDF and send it on"
            onClick={() => setExporting(true)}
            disabled={!!capturing}
          >{capturing ? 'Saving PDF…' : 'Export report'}</button>
        </div>
      )}

      {exporting && (
        <FlowReportModal
          flowName={flow.name}
          onCancel={() => setExporting(false)}
          onExport={(reveal) => { setExporting(false); setCapturing({ reveal }); }}
        />
      )}

      {/* Rendered into the body inside a frame clipped to nothing: html2pdf
          reads the document there, turns it into the download, then it
          unmounts. */}
      {capturing && report && createPortal(
        <div className="export-capture-frame">
          <FlowReportDoc
            flow={flow}
            report={report}
            environmentName={environmentName}
            reveal={capturing.reveal}
            capture
          />
        </div>,
        document.body,
      )}

      {/* The flow as a chain of nodes on the left, and whichever one is picked
          spelled out on the right. A node says what the step is and how it
          went; everything else — what it sent, what came back, the controls —
          is read one step at a time, so it lives in the detail rather than
          being unfolded row by row. Each side scrolls on its own, so reading a
          long response never loses your place in the chain. */}
      <div className="flow-split">
      <div className="flow-scroll">
      {/* The steps' own gaps are handled by the nodes; this catches the space
          under the last one, where "move it to the end" is aimed. */}
      <div
        className="flow-steps flow-nodes"
        onDragOver={(e) => {
          if (!draggingStep(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (e.target === e.currentTarget) setDropAt(flow.steps.length);
        }}
        onDrop={(e) => {
          if (!draggingStep(e)) return;
          e.preventDefault();
          const id = dragStepRef.current || e.dataTransfer.getData(STEP_DRAG_TYPE);
          const at = dropAt;
          endDrag();
          if (at != null) dropStep(id, at);
        }}
      >
        {flow.steps.length === 0 && (
          <p className="hint">No steps yet — add one with Add step.</p>
        )}
        {flow.steps.map((step, i) => {
          const rep = stepReport(step.id);
          const sum = stepSummary(step);
          return (
            <div
              key={step.id}
              className={[
                'flow-step',
                'flow-node',
                rep ? (rep.skipped ? 'skipped' : rep.ok ? 'pass' : 'fail') : '',
                selected && selected.id === step.id ? 'selected' : '',
                dragStepId === step.id ? 'dragging' : '',
                dropAt === i ? 'drop-above' : '',
                // Only the last node answers for the gap under it; every other
                // gap is some node's "above".
                dropAt === flow.steps.length && i === flow.steps.length - 1 ? 'drop-below' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => setSelectedId(step.id)}
              onDragOver={(e) => stepDragOver(e, i)}
              onDrop={(e) => {
                if (!draggingStep(e)) return;
                e.preventDefault();
                e.stopPropagation();
                const id = dragStepRef.current || e.dataTransfer.getData(STEP_DRAG_TYPE);
                const at = dropAt;
                endDrag();
                if (at != null) dropStep(id, at);
              }}
            >
              <div className="flow-step-head">
                <span
                  className="step-grip"
                  role="button"
                  tabIndex={0}
                  aria-label={`Reorder step ${i + 1}`}
                  draggable
                  title="Drag to reorder — or ↑ / ↓ while focused"
                  onDragStart={(e) => {
                    dragStepRef.current = step.id;
                    setDragStepId(step.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData(STEP_DRAG_TYPE, step.id);
                    // Firefox refuses to start a drag that carries no text/plain.
                    e.dataTransfer.setData('text/plain', stepLabel(step, i));
                    // Otherwise the thing in flight is the grip itself, which
                    // says nothing about which step is moving.
                    const row = e.currentTarget.closest('.flow-step');
                    if (row) e.dataTransfer.setDragImage(row, 24, 18);
                  }}
                  // Also on a drag that ended nowhere, or the row stays faded.
                  onDragEnd={endDrag}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                    e.preventDefault();
                    move(i, e.key === 'ArrowUp' ? -1 : 1);
                  }}
                />
                <span className="step-no">{i + 1}</span>
                <span className="node-name">{stepLabel(step, i)}</span>
                {resultBadge(rep)}
              </div>
              {(() => {
                const u = resolvedUrl(step);
                return (
                  <div className={`node-sub ${sum.warn ? 'warn' : ''}`}>
                    {sum.lead && <span className="step-summary-lead">{sum.lead}</span>}
                    <span className="step-summary-what" title={u ? u.url : sum.what}>
                      {u ? urlPath(u.url) : sum.what}
                    </span>
                  </div>
                );
              })()}
              {stepFlags(step)}
              {/* The line down to the next node, drawn by the node itself so
                  nothing sits between two nodes to catch a drop. */}
              {i < flow.steps.length - 1 && <span className="node-link" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
      </div>

      <div className="flow-detail">
        {selected && (() => {
          const step = selected;
          const i = flow.steps.indexOf(step);
          const rep = stepReport(step.id);
          const sum = stepSummary(step);
          return (
            <>
              <div className="flow-step-head">
                <span className="step-no">{i + 1}</span>
                <input
                  className="step-name"
                  value={step.name}
                  placeholder="Step name"
                  onChange={(e) => setStep(step.id, { name: e.target.value })}
                />
                {/* Run this one on its own — the loop of fixing a request and
                    trying it again, without the steps in front of it. It starts
                    with only the flow's own vars, so a step that needs what an
                    earlier one captured will say so. */}
                <button
                  className="mini bar-act step-play"
                  title="Run just this step (without the ones before it)"
                  disabled={running || !!runningStep}
                  onClick={() => onRunStep(step.id)}
                >
                  {runningStep === step.id ? <span className="step-spin">◌</span> : <IconPlay />}
                </button>
                <button
                  className="mini bar-act"
                  title="Edit — what it runs, when it runs, extractions, assertions, script"
                  onClick={() => setOpenStep(step.id)}
                ><IconPencil /></button>
                <button
                  className="mini bar-act danger"
                  title="Remove step"
                  onClick={() => removeStep(step, i)}
                ><IconClose /></button>
              </div>
              {stepFlags(step)}

              {(() => {
                const u = resolvedUrl(step);
                return (
                  <>
                    <div className={`step-summary ${sum.warn ? 'warn' : ''}`}>
                      {sum.lead && <span className="step-summary-lead">{sum.lead}</span>}
                      <span className="step-summary-what" title={u ? u.url : sum.what}>
                        {u ? u.url : sum.what}
                      </span>
                      {resultBadge(rep)}
                      {sum.where && <span className="step-summary-where">{sum.where}</span>}
                    </div>
                    {/* What it was written as — a saved step by its name as
                        well — so the url above can be traced back to it. */}
                    {u && (u.template !== u.url || step.mode === 'saved') && (
                      <div className="step-template">
                        {step.mode === 'saved' && sum.what !== u.template && <>{sum.what} · </>}
                        <code>{u.template}</code>
                      </div>
                    )}
                  </>
                );
              })()}

              {/* An HTTP response lists what it captured itself; a command's
                  output does not, so it is said here instead. */}
              {rep && rep.extracted && !rep.response && (
                <div className="step-extracted">
                  captured {Object.entries(rep.extracted).map(([k, v]) => `${k} = ${v}`).join(', ')}
                </div>
              )}
              {hasOutput(rep)
                ? (rep!.shell ? <StepShellOutput rep={rep!} /> : <StepResponse rep={rep!} />)
                : (
                  <div className="step-response">
                    {/* A refused send and a command that never started have no
                        output at all, and the call is then the whole of what
                        there is to read. */}
                    {rep && !rep.skipped && <StepSent rep={rep} />}
                    {rep && rep.error && (
                      <div className="step-checks"><div className="err">✗ {rep.error}</div></div>
                    )}
                    {rep && rep.hint && <p className="hint">{rep.hint}</p>}
                    <p className="hint">
                      {!rep ? 'Not run yet — run the flow, or just this step, to see what came back.'
                        : rep.skipped ? `Skipped — ${rep.skipped}.`
                        : 'Nothing came back.'}
                    </p>
                  </div>
                )}

              {openStep === step.id && (
                <StepEditModal
                  step={step}
                  index={i}
                  label={stepLabel(step, i)}
                  collections={collections}
                  onChange={(patch) => setStep(step.id, patch)}
                  onClose={() => setOpenStep(null)}
                />
              )}
            </>
          );
        })()}
      </div>
      </div>

      {adding && (
        <AddStepModal onAdd={addStep} onCancel={() => setAdding(false)} />
      )}
    </div>
  );
}
