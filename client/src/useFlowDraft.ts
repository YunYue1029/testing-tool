import { useRef, useState } from 'react';
import { api } from './api.ts';
import useAutoSave from './useAutoSave.ts';
import type { Flow, RunReport } from './types.ts';

interface Deps {
  putFlow: (f: Flow) => void;
}

export interface FlowDraft {
  flow: Flow | null; // the open flow, or null for the request view
  dirty: boolean;
  edit: (flow: Flow) => void;
  // Show another flow. Not an edit; what was pending for the one before is
  // flushed first.
  open: (flow: Flow) => Promise<void>;
  // Back to the request view, the pending edit written on the way out —
  // or dropped, when the flow was just deleted and a write would only
  // bring it back.
  close: () => Promise<void>;
  discard: () => void;
  flush: () => Promise<void>;
  // The server's copy arrived: take it, unless edits here are waiting.
  takeUpdate: (flows: Flow[]) => void;

  report: RunReport | null;
  forgetReports: (ids: string[]) => void;
  running: boolean;
  runningStep: string | null; // step id being run on its own
  runFlow: (envId: string | null) => Promise<void>;
  runStep: (stepId: string, envId: string | null) => Promise<void>;
}

// A flow is rewritten whole, so its updatedAt moves even when nothing about
// it did; comparing without it keeps the open flow from being replaced by
// an identical copy.
const sameFlow = (a: Flow, b: Flow) =>
  JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });

// The flow in the panel: the open one, its auto-save, and the last run of
// every flow.
export default function useFlowDraft({ putFlow }: Deps): FlowDraft {
  // Edits are debounced like a request's: a flow is one document, so the
  // whole thing is written each time.
  const autoSave = useAutoSave<Flow>(null, async (f) => putFlow(await api.saveFlow(f)));
  const flow = autoSave.draft;
  const flowRef = useRef(flow);
  flowRef.current = flow;

  // The last run of each flow, by flow id. Switching between a test and a flow
  // is a dozen times an hour, and a report that went away on the way out meant
  // running the flow again to read what it had already said. In memory only:
  // a report answers for the flow as it stood minutes ago, and one restored
  // from yesterday's tab would be answering for something else.
  const [reports, setReports] = useState<Record<string, RunReport>>({});
  const forgetReports = (ids: string[]) => setReports((all) => {
    const next = { ...all };
    for (const id of ids) delete next[id];
    return next;
  });
  const [running, setRunning] = useState(false);
  const [runningStep, setRunningStep] = useState<string | null>(null);

  // Save first: a report is only meaningful for the steps as they stand.
  // A write that failed leaves the draft dirty, and running the server's
  // older copy would report on something other than what is on screen.
  async function saveFirst() {
    await autoSave.flush();
    if (autoSave.dirty) throw new Error('The flow could not be saved first');
  }

  async function runFlow(envId: string | null) {
    if (!flow) return;
    // Which flow this run answers for, held here rather than read back off
    // `flow` at the end: the run takes seconds, and by then the open flow may
    // be another one entirely.
    const id = flow.id;
    setRunning(true);
    forgetReports([id]);
    try {
      await saveFirst();
      const rep = await api.runFlow(id, { environment: envId || undefined });
      setReports((all) => ({ ...all, [id]: rep }));
    } catch (e) {
      setReports((all) => ({
        ...all,
        [id]: { ok: false, durationMs: 0, steps: [], vars: {}, error: (e as Error).message },
      }));
      alert(`Could not run the flow: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  // Run a single step. Its result replaces that step's row and leaves every
  // other row showing what it already showed — this run answers for one step,
  // so it must not claim to have re-answered for the rest.
  async function runStep(stepId: string, envId: string | null) {
    if (!flow) return;
    const id = flow.id;
    setRunningStep(stepId);
    try {
      await saveFirst();
      const rep = await api.runFlowStep(id, stepId, { environment: envId || undefined });
      const entry = rep.steps[0]!;
      setReports((all) => {
        const prev = all[id];
        const kept = (prev && prev.steps) || [];
        return {
          ...all,
          [id]: {
            ...rep,
            steps: kept.some((s) => s.id === stepId)
              ? kept.map((s) => (s.id === stepId ? entry : s))
              : [...kept, entry],
            vars: { ...(prev && prev.vars), ...rep.vars },
            // What the summary bar reports on, so it says "step" rather than
            // passing a one-step run off as the whole flow.
            oneStep: stepId,
          },
        };
      });
    } catch (e) {
      alert(`Could not run the step: ${(e as Error).message}`);
    } finally {
      setRunningStep(null);
    }
  }

  return {
    flow,
    get dirty() { return autoSave.dirty; },
    edit: autoSave.edit,
    async open(f) {
      await autoSave.flush();
      autoSave.replace(f);
    },
    async close() {
      await autoSave.flush();
      autoSave.replace(null);
    },
    discard: () => autoSave.replace(null),
    flush: autoSave.flush,
    takeUpdate(flows) {
      const mine = flowRef.current;
      if (!mine || autoSave.dirty) return;
      const theirs = flows.find((f) => f.id === mine.id);
      if (theirs && !sameFlow(theirs, mine)) autoSave.replace(theirs);
    },
    report: flow ? reports[flow.id] || null : null,
    forgetReports,
    running,
    runningStep,
    runFlow,
    runStep,
  };
}
