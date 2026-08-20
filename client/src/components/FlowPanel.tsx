import React, { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { IconPlus, IconClose, IconPencil, IconPlay } from './Icons';
import AddStepModal from './AddStepModal';
import StepEditModal from './StepEditModal';
import { uid, prettify, fmtSize, emptyInlineRequest, fitToContent } from '../util';
import type {
  Collection, Flow, FlowShell, InlineRequest, Step, StepReport,
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
}

// Its own type, like the sidebar's two: it says a dragover is one of ours, and
// keeps a file dragged in from the desktop from looking like a step.
const STEP_DRAG_TYPE = 'application/x-testing-tool-step';

function emptyStep(): Step {
  return {
    // Direct, because a step added by name alone has nothing picked yet and
    // Direct is the one you can finish by typing — the other two need a
    // request chosen or a command written before they run at all.
    id: uid(), mode: 'inline', collectionId: null, requestId: null,
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

// One flow: an ordered list of requests run together, with the values each step
// hands to the next and the checks on what came back.
export default function FlowPanel({
  flow, collections, onChange, onRun, onRunStep, onDelete, running, runningStep, report,
}: FlowPanelProps) {
  const [openStep, setOpenStep] = useState<string | null>(null); // step id whose detail is expanded
  const [adding, setAdding] = useState(false); // the "add step" dialog is up
  // Which steps have their response opened. A failing step opens itself — that
  // is the one you came to read — until you say otherwise, hence storing the
  // choice rather than the state.
  const [respOpen, setRespOpen] = useState<Record<string, boolean>>({});
  // A new run answers different questions than the last one did.
  useEffect(() => { setRespOpen({}); }, [report]);

  // The description sizes itself to its text, but the ref callback below only
  // fires on mount — switching flows reuses the same textarea, so without this
  // a short description would keep the height the last flow's long one left
  // behind, and an empty one would open as a block of blank.
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => { fitToContent(descRef.current); }, [flow.id, flow.description]);

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
  const showsResponse = (step: Step, rep: StepReport | null | undefined) => (
    respOpen[step.id] !== undefined ? respOpen[step.id] : !!(rep && !rep.ok && hasOutput(rep))
  );

  // Every step's output at once — reading a run means reading all of them, and
  // eight carets is eight clicks. It says which way it will go from what is on
  // screen now, so it always changes something: anything still closed means the
  // press opens; nothing closed means it closes.
  const allShown = flow.steps.length > 0
    && flow.steps.every((s) => showsResponse(s, stepReport(s.id)));

  function toggleAllResponses() {
    // Written out per step rather than emptied back to the default, because the
    // default is not "closed" — a failed step opens itself, and collapsing all
    // has to be able to close that too.
    const next: Record<string, boolean> = {};
    for (const s of flow.steps) next[s.id] = !allShown;
    setRespOpen(next);
  }

  return (
    <div className="flow-panel">
      <div className="flow-head">
        {/* Ahead of the name, where every step keeps its own caret — the flow is
            the outermost node, so the control that opens all of it belongs in
            that same left-hand column. Bare glyph, no label: what it does is the
            same thing the carets below it do, and the title says the rest. */}
        <button
          className="mini expand-all"
          title={allShown
            ? 'Close every step’s output'
            : 'Open every step’s output — what each one sent and got back'}
          disabled={!flow.steps.length}
          onClick={toggleAllResponses}
        >
          <span className={`caret ${allShown ? 'open' : ''}`}>▸</span>
        </button>
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
          not made to carry one. */}
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
          {Object.keys(report.vars || {}).length > 0 && (
            <span className="hint-inline">
              {' '}· captured: {Object.entries(report.vars).map(([k, v]) => `${k}=${String(v).slice(0, 20)}`).join(', ')}
            </span>
          )}
        </div>
      )}

      {/* Only the steps scroll. Run and Delete belong to the whole flow, so
          reading the last step should not mean scrolling back up to press
          them. */}
      <div className="flow-scroll">
      {/* The steps' own gaps are handled by the rows; this catches the space
          under the last one, where "move it to the end" is aimed. */}
      <div
        className="flow-steps"
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
        {flow.steps.map((step, i) => {
          const rep = stepReport(step.id);
          const open = openStep === step.id;
          return (
            <div
              key={step.id}
              className={[
                'flow-step',
                rep ? (rep.skipped ? 'skipped' : rep.ok ? 'pass' : 'fail') : '',
                dragStepId === step.id ? 'dragging' : '',
                dropAt === i ? 'drop-above' : '',
                // Only the last row answers for the gap under it; every other
                // gap is some row's "above".
                dropAt === flow.steps.length && i === flow.steps.length - 1 ? 'drop-below' : '',
              ].filter(Boolean).join(' ')}
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
                {/* Always here, run or not: the way into a step's output should
                    be in the same place before you have run anything, not a
                    control that appears once there is a status to click. */}
                <button
                  className="mini step-toggle"
                  title={showsResponse(step, rep) ? 'Hide the output' : 'Show what came back'}
                  onClick={() => setRespOpen({ ...respOpen, [step.id]: !showsResponse(step, rep) })}
                >
                  <span className={`caret ${showsResponse(step, rep) ? 'open' : ''}`}>▸</span>
                </button>
                {/* Run this one on its own — the loop of fixing a request and
                    trying it again, without the steps in front of it. It starts
                    with no run variables, so a step that needs what an earlier
                    one captured will say so. */}
                <button
                  className="mini step-play"
                  title="Run just this step (without the ones before it)"
                  disabled={running || !!runningStep}
                  onClick={() => onRunStep(step.id)}
                >
                  {runningStep === step.id ? <span className="step-spin">◌</span> : <IconPlay />}
                </button>
                {/* A part of the row whose whole job is being grabbed, so what
                    can be dragged is visible rather than something you have to
                    discover. A span and not a <button>: Chrome and Safari never
                    start a drag from a form control, whatever `draggable` says,
                    which is why the number could not be dragged. role and
                    tabIndex give back what the button element was providing. */}
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
                <input
                  className="step-name"
                  value={step.name}
                  placeholder="Step name"
                  onChange={(e) => setStep(step.id, { name: e.target.value })}
                />
                {/* Both flags are edited behind the pencil; only the one that
                    changes when the step runs is worth a place out here. */}
                {step.always && (
                  <span className="step-flag" title="Runs even after an earlier step failed">
                    teardown
                  </span>
                )}
                {step.enabled === false && (
                  <span className="step-flag off" title="Skipped — this step is disabled">
                    disabled
                  </span>
                )}

                <button
                  className="mini bar-act"
                  title={open ? 'Hide details' : 'Extractions, assertions, script'}
                  onClick={() => setOpenStep(open ? null : step.id)}
                ><IconPencil /></button>
                <button
                  className="mini bar-act danger"
                  title="Remove step"
                  onClick={() => removeStep(step, i)}
                ><IconClose /></button>
              </div>

              {/* What this step sends and how it went, on one line: the call
                  and its verdict are read together. Read-only — the pickers
                  behind it live in the dialog the pencil opens, so nothing here
                  changes under a stray click. */}
              {(() => {
                const s = stepSummary(step);
                return (
                  <div className={`step-summary ${s.warn ? 'warn' : ''}`}>
                    {s.lead && <span className="step-summary-lead">{s.lead}</span>}
                    <span className="step-summary-what">{s.what}</span>
                    {rep && (
                      <span className={`step-result ${
                        rep.skipped ? '' : rep.shell ? (rep.exitCode === 0 ? 'ok' : 'err') : statusClass(rep.status)}`}
                      >
                        {rep.skipped ? 'skipped' : rep.shell ? `exit ${rep.exitCode}` : rep.status}
                        {rep.timeMs != null && ` · ${rep.timeMs}ms`}
                      </span>
                    )}
                    {s.where && <span className="step-summary-where">{s.where}</span>}
                  </div>
                );
              })()}

              {/* Both summaries below are the closed-up view of what the
                  response panel spells out, so they stand down when it opens. */}
              {rep && !rep.ok && !rep.skipped && !showsResponse(step, rep) && (
                <div className="step-failures">
                  {(rep.assertions || []).filter((a) => !a.ok).map((a, k) => (
                    <div key={k}>✗ {a.detail}</div>
                  ))}
                  {rep.error && <div>✗ {rep.error}</div>}
                  {rep.script && <div>✗ script: {rep.script.error}</div>}
                </div>
              )}
              {rep && rep.ok && rep.extracted && !showsResponse(step, rep) && (
                <div className="step-extracted">
                  captured {Object.entries(rep.extracted).map(([k, v]) => `${k} = ${v}`).join(', ')}
                </div>
              )}
              {/* Opening a step that has not run says so rather than doing
                  nothing — the toggle is there before there is a run, so it has
                  to answer for itself. */}
              {showsResponse(step, rep) && (
                hasOutput(rep)
                  ? (rep!.shell ? <StepShellOutput rep={rep!} /> : <StepResponse rep={rep!} />)
                  : (
                    <div className="step-response">
                      {/* A refused send and a command that never started have
                          no output at all, and the call is then the whole of
                          what there is to read — it used to say "no output" and
                          leave the url and the error to be guessed at. */}
                      {rep && !rep.skipped && <StepSent rep={rep} />}
                      {rep && rep.error && (
                        <div className="step-checks"><div className="err">✗ {rep.error}</div></div>
                      )}
                      {rep && rep.hint && <p className="hint">{rep.hint}</p>}
                      <p className="hint">
                        {!rep ? 'Not run yet — run the flow to see what came back.'
                          : rep.skipped ? `Skipped — ${rep.skipped}.`
                          : 'Nothing came back.'}
                      </p>
                    </div>
                  )
              )}

              {open && (
                <StepEditModal
                  step={step}
                  index={i}
                  label={stepLabel(step, i)}
                  collections={collections}
                  onChange={(patch) => setStep(step.id, patch)}
                  onClose={() => setOpenStep(null)}
                />
              )}
            </div>
          );
        })}
      </div>
      </div>

      {adding && (
        <AddStepModal onAdd={addStep} onCancel={() => setAdding(false)} />
      )}
    </div>
  );
}
