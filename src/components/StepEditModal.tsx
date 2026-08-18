import React from 'react';
import { RequestOptions } from './AddStepModal';
import RequestAuthEditor from './RequestAuthEditor';
import { emptyInlineRequest, METHODS, fitToContent } from '../util';
import type {
  Assertion, AssertOp, Collection, InlineBodyType, InlineRequest, Row, Step,
  StepMode, ValueSource,
} from '../types.ts';

// The three things a step can be, with the reason you would pick each. The
// choice decides what the rest of this dialog asks for, so it reads as a row of
// three rather than a dropdown that hides two of them.
const MODES = [
  ['saved', 'Saved', 'A request already in a collection.'],
  ['inline', 'Direct', 'Type the request here. A step that exists to exercise a case is a test — saving it would file a test case among the collection’s real endpoints.'],
  ['shell', 'Shell', 'A command, for the part of a feature no response shows: that the row really landed, the file was written, the queue drained.'],
];

const SOURCES = ['status', 'body', 'header', 'cookie', 'time'];
// What a shell step has instead: its verdict and the two streams it wrote.
const SHELL_SOURCES = ['exit_code', 'stdout', 'stderr', 'time'];
// Sources that are a single value rather than a document, so there is nothing
// for a path to dig into.
const PATHLESS = ['status', 'time', 'exit_code'];
const OPS = ['eq', 'neq', 'exists', 'missing', 'contains', 'matches', 'lt', 'gt'];
const NO_VALUE = ['exists', 'missing'];
const BODY_TYPES = ['none', 'json', 'text'];

// Edit a list of rows with a trailing blank, so there is nothing to click to
// add one. A row counts as untouched only while it still equals the blank
// template — every field of an assert row carries a default, so asking
// whether any field "has a value" can neither spot a pristine row (which
// used to get stored and then fail every run) nor keep a row whose only
// edit so far is a dropdown.
// A row of either list: an extraction or an assertion, both plain string maps
// as far as this editor is concerned.
type EditableRow = object;

function rowEditor<T extends EditableRow>(
  rows: T[] | undefined, onRows: (rows: T[]) => void, blank: T,
) {
  const field = (r: T, k: string) => (r as Record<string, unknown>)[k];
  const untouched = (r: T) =>
    Object.keys(blank).every((k) => (field(r, k) ?? '') === field(blank, k));
  const stored = rows || [];
  const shown = stored.length && untouched(stored[stored.length - 1]!)
    ? stored
    : [...stored, { ...blank }];
  return {
    shown,
    untouched,
    update: (i: number, patch: Partial<T>) => onRows(
      shown.map((r, k) => (k === i ? { ...r, ...patch } : r)).filter((r) => !untouched(r)),
    ),
    // A row someone typed into, removed outright — clearing every field by
    // hand to make it "untouched" again is not how anyone expects delete to
    // work.
    remove: (i: number) => onRows(shown.filter((_, k) => k !== i)),
  };
}

// Everything about one step that isn't visible on the flow: what it runs, and
// the extractions, assertions and script hung off it. A dialog rather than an
// panel opening in place, because a step's settings are long enough to push the
// rest of the flow off screen — and reading the flow is what the list is for.
interface StepEditModalProps {
  step: Step;
  index: number;
  label: string;
  collections: Collection[];
  onChange: (step: Step) => void;
  onClose: () => void;
}

export default function StepEditModal(
  { step, index, label, collections, onChange, onClose }: StepEditModalProps,
) {
  const inline = step.mode === 'inline';
  // The saved test this step points at, when it points at one: a saved shell
  // test runs a command, so the rows below have to offer a command's sources
  // rather than a response's — otherwise a step asserting on stdout could only
  // be written by picking `body` and hoping.
  const picked = (step.mode || 'saved') === 'saved' && step.requestId
    ? ((collections.find((c) => c.id === step.collectionId) || {}).requests || [])
      .find((r) => r.id === step.requestId)
    : null;
  const shell = step.mode === 'shell';
  const savedShell = !!(picked && picked.kind === 'shell');
  // Whether this step ends up with a command's result to read, whichever way it
  // got there — that is what the extract and assert rows below ask about.
  const readsShell = shell || savedShell;
  const sources = readsShell ? SHELL_SOURCES : SOURCES;
  const req = step.request || emptyInlineRequest();

  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch });
  // Patch the request typed into a step, filling in the defaults for a step
  // saved before inline requests existed.
  const setInline = (patch: Partial<InlineRequest>) =>
    set({ request: { ...emptyInlineRequest(), ...(step.request || {}), ...patch } });

  // Headers and query params for an inline request: the same trailing-blank
  // editing as the rows below, in two columns.
  function inlineRows(key: 'headers' | 'params', placeholders: [string, string]) {
    const ed = rowEditor<Row>(
      (step.request || {})[key], (rows) => setInline({ [key]: rows }), { key: '', value: '' },
    );
    return (
      <table className="kv">
        <tbody>
          {ed.shown.map((r, k) => (
            <tr key={k}>
              <td><input
                value={r.key || ''} placeholder={placeholders[0]}
                onChange={(e) => ed.update(k, { key: e.target.value })}
              /></td>
              <td><input
                value={r.value || ''} placeholder={placeholders[1]}
                onChange={(e) => ed.update(k, { value: e.target.value })}
              /></td>
              <td className="kv-del">
                {!ed.untouched(r) && <button title="Remove" onClick={() => ed.remove(k)}>×</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    // Every edit lands on the flow as it is typed, so there is nothing to
    // cancel — clicking away is a perfectly good way to be finished.
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal modal-wide">
        {/* Says which step this is, no more: the name is edited on the row,
            and one field in two places is one field too many. */}
        <h3>Step {index + 1}{label ? ` — ${label}` : ''}</h3>

        <div className="field-label">What it runs</div>
        {/* Three ways to say what a step does; each one's settings are kept
            whichever is active, so switching back costs nothing. Each carries
            its own reason as a tooltip: the button is the thing you are already
            pointing at when you want to know. */}
        <div className="modal-modes">
          {MODES.map(([value, label, why]) => (
            <button
              key={value}
              type="button"
              title={why}
              className={(step.mode || 'saved') === value ? 'active' : ''}
              onClick={() => set({ mode: value as StepMode })}
            >{label}</button>
          ))}
        </div>
        <div className="step-what">
          {!shell && (
            <select
              value={step.collectionId || ''}
              title={inline
                ? 'Optional — only lends this step its base URL and default auth'
                : 'Which collection the request lives in'}
              onChange={(e) => set({ collectionId: e.target.value || null, requestId: null })}
            >
              <option value="">{inline ? 'No collection' : 'Collection…'}</option>
              {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {!inline && !shell && (
            <select
              value={step.requestId || ''}
              disabled={!step.collectionId}
              onChange={(e) => set({ requestId: e.target.value || null })}
            >
              <option value="">Request…</option>
              <RequestOptions collections={collections} collectionId={step.collectionId} />
            </select>
          )}
        </div>

        {/* A saved shell test: the command lives on the test, so it is shown
            here rather than offered for editing — one command in two places is
            one too many, and the other flows pointing at it would not see the
            edit anyway. */}
        {savedShell && (
          <div className="step-shell-cmd" title="Edit it where it is saved, under Tests">
            <code>{picked.command || '(no command yet)'}</code>
          </div>
        )}

        {inline && (
          <div className="step-request">
            <select
              className="step-method"
              value={req.method || 'GET'}
              onChange={(e) => setInline({ method: e.target.value })}
            >{METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</select>
            <input
              className="step-url"
              value={req.url || ''}
              placeholder="{{base_url}}/widgets/{{widget_id}}"
              onChange={(e) => setInline({ url: e.target.value })}
            />
          </div>
        )}

        {/* No per-step working directory: the flow runs in one shell, and where
            that shell starts is a property of the flow, set once on its bar. A
            step that quietly cd'd somewhere would change the ground under every
            step after it — a scenario no flow here has ever wanted. */}
        {shell && (
          <div className="step-request step-request-shell">
            <textarea
              className="step-url step-command"
              value={step.command || ''}
              placeholder='docker exec db psql -tAc "select count(*) from users where id={{user_id}}"'
              spellCheck={false}
              rows={2}
              ref={fitToContent}
              onChange={(e) => { fitToContent(e.target); set({ command: e.target.value }); }}
            />
            <input
              className="step-timeout"
              type="number"
              min="0"
              value={step.timeout || ''}
              placeholder="30000"
              title="Timeout in ms — the command is killed past it (default 30000)"
              onChange={(e) => set({ timeout: Number(e.target.value) || undefined })}
            />
          </div>
        )}

        <div className="flow-step-flags">
          <label title="Unchecked steps are skipped">
            <input
              type="checkbox"
              checked={step.enabled !== false}
              onChange={(e) => set({ enabled: e.target.checked })}
            /> enabled
          </label>
          <label title="Runs even after an earlier step failed — use it for cleanup">
            <input
              type="checkbox"
              checked={!!step.always}
              onChange={(e) => set({ always: e.target.checked })}
            /> always run (teardown)
          </label>
        </div>

        {inline && (
          <>
            {/* The reason a step needs its own say: a login typed into a flow
                must go out unauthenticated, and until now an inline step could
                only inherit. */}
            <RequestAuthEditor
              key={step.id}
              label="Auth"
              auth={req.auth}
              collectionName={(collections.find((c) => c.id === step.collectionId) || {}).name}
              onChange={(auth) => setInline({ auth })}
            />

            <div className="field-label">Headers</div>
            {inlineRows('headers', ['Authorization', 'Bearer {{token}}'])}

            <div className="field-label">Query params</div>
            {inlineRows('params', ['page', '1'])}

            <div className="field-label">
              Body
              <span className="body-type inline-body-type">
                {BODY_TYPES.map((t) => (
                  <label key={t}>
                    <input
                      type="radio"
                      name={`bodyType-${step.id}`}
                      checked={(req.bodyType || 'none') === t}
                      onChange={() => setInline({ bodyType: t as InlineBodyType })}
                    />
                    {t.toUpperCase()}
                  </label>
                ))}
              </span>
            </div>
            {(req.bodyType || 'none') !== 'none' && (
              <textarea
                className="body-text step-body-text"
                value={req.body || ''}
                placeholder={req.bodyType === 'json' ? '{\n  "key": "value"\n}' : 'Request body'}
                onChange={(e) => setInline({ body: e.target.value })}
              />
            )}
          </>
        )}

        <div className="field-label">
          Extract — capture a value for later steps to use as <code>{'{{var}}'}</code>
        </div>
        <table className="kv">
          <tbody>
            {(() => {
              const ex = rowEditor(
                step.extract,
                (extract) => set({ extract }),
                { var: '', from: readsShell ? 'stdout' : 'body', path: '' },
              );
              return ex.shown.map((e, k) => (
                <tr key={k}>
                  <td><input
                    value={e.var || ''} placeholder="variable"
                    onChange={(ev) => ex.update(k, { var: ev.target.value })}
                  /></td>
                  <td className="narrow"><select
                    value={e.from || (readsShell ? 'stdout' : 'body')}
                    onChange={(ev) => ex.update(k, { from: ev.target.value as ValueSource })}
                  >{sources.map((s) => <option key={s} value={s}>{s}</option>)}</select></td>
                  <td><input
                    value={e.path || ''}
                    placeholder={PATHLESS.includes(e.from || '') ? '—' : 'data.id'}
                    disabled={PATHLESS.includes(e.from || '')}
                    onChange={(ev) => ex.update(k, { path: ev.target.value })}
                  /></td>
                  <td className="kv-del">
                    {!ex.untouched(e) && <button title="Remove" onClick={() => ex.remove(k)}>×</button>}
                  </td>
                </tr>
              ));
            })()}
          </tbody>
        </table>

        <div className="field-label">
          {readsShell
            ? 'Assert — what the command must have done. Without a row here a non-zero exit fails the step on its own.'
            : 'Assert — what the response must look like'}
        </div>
        <table className="kv">
          <tbody>
            {(() => {
              const as = rowEditor(
                step.assert,
                (a) => set({ assert: a }),
                { source: readsShell ? 'exit_code' : 'status', path: '', op: 'eq', value: '' },
              );
              return as.shown.map((a, k) => {
                const update = (patch: Partial<Assertion>) => as.update(k, patch);
                return (
                  <tr key={k}>
                    <td className="narrow"><select
                      value={a.source || (readsShell ? 'exit_code' : 'status')}
                      onChange={(e) => update({ source: e.target.value as ValueSource })}
                    >{sources.map((s) => <option key={s} value={s}>{s}</option>)}</select></td>
                    <td><input
                      value={a.path || ''}
                      placeholder={PATHLESS.includes(a.source || '') ? '—' : 'data.id'}
                      disabled={PATHLESS.includes(a.source || '')}
                      onChange={(e) => update({ path: e.target.value })}
                    /></td>
                    <td className="narrow"><select
                      value={a.op || 'eq'}
                      onChange={(e) => update({ op: e.target.value as AssertOp })}
                    >{OPS.map((o) => <option key={o} value={o}>{o}</option>)}</select></td>
                    <td><input
                      value={a.value == null ? '' : String(a.value)}
                      placeholder={NO_VALUE.includes(a.op || '') ? '—' : (readsShell ? '0' : '200')}
                      disabled={NO_VALUE.includes(a.op || '')}
                      onChange={(e) => update({ value: e.target.value })}
                    /></td>
                    <td className="kv-del">
                      {!as.untouched(a) && <button title="Remove" onClick={() => as.remove(k)}>×</button>}
                    </td>
                  </tr>
                );
              });
            })()}
          </tbody>
        </table>

        <div className="field-label">
          Script — for checks the rows above can&apos;t express. <code>expect(cond, message)</code>,
          plus <code>res</code> and <code>env</code> (run-scoped here).
        </div>
        <textarea
          className="body-text step-script"
          value={step.script || ''}
          placeholder={"expect(res.json().data.items.length > 0, 'list is not empty')"}
          onChange={(e) => set({ script: e.target.value })}
        />

        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn-send" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
