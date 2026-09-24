import { useEffect, useRef, useState } from 'react';

// The delay the request panel has always used: long enough that a burst of
// typing is one write, short enough that closing a dialog right after a
// keystroke is not a race.
const DELAY = 600;

// 'Updated' is not a save at all: the poll put the server's newer copy in
// front of you, and the status line is where that is said.
type SaveStatus = '' | 'Saving…' | 'Saved' | 'Save failed' | 'Updated';

// A new draft, or one worked out from the current one.
type Next<T> = T | null | ((cur: T | null) => T | null);

interface AutoSave<T> {
  draft: T | null;
  status: SaveStatus;
  // Whether the draft holds something the server has not accepted yet.
  dirty: boolean;
  // An edit: written a moment after the last one.
  edit: (next: Next<T>) => void;
  // A change the server already holds — a rename made through its own
  // endpoint, a new record learning its id. Shown, and carried along by a
  // pending write if there is one, but not itself a reason to write.
  patch: (next: Next<T>) => void;
  // Another record, or the server's copy of this one, or nothing (the editor
  // closed). Opening is not an edit, and whatever write was pending was for
  // the record going away: callers flush first when that matters.
  replace: (next: Next<T>, status?: SaveStatus) => void;
  // Write a pending edit now instead of in 600ms — what closing a dialog or
  // opening another record does, so the last keystroke still lands.
  flush: () => Promise<void>;
}

// Persist `draft` a moment after it stops changing, the way an open request is
// already persisted — so an editor has nothing left to forget to save. The
// hook holds the draft itself, because only then can it tell the three ways a
// draft changes apart: an edit is written, a swap is not, and a patch rides on
// whatever is already waiting.
//
// Nothing here can lose the last edit: a pending write is flushed on close and
// again when the editor unmounts, whichever comes first.
export default function useAutoSave<T>(
  initial: T | null | (() => T | null),
  save: (draft: T) => Promise<unknown> | unknown,
): AutoSave<T> {
  const [draft, setDraft] = useState<T | null>(initial);
  const [status, setStatus] = useState<SaveStatus>('');
  // Kept in step by hand, before React re-renders: a write fired by a timer
  // must never see a draft one keystroke old, nor go through a stale save.
  const latest = useRef(draft);
  const saveRef = useRef(save);
  saveRef.current = save;
  const dirty = useRef(false);
  // Counts edits, so a write that finishes after further typing knows those
  // keystrokes are still owed rather than marking the draft clean.
  const edits = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  async function write(): Promise<void> {
    cancel();
    const d = latest.current;
    // The editor closed, or what was being edited is gone (a deleted
    // environment): there is nothing left that a write could be about.
    if (d == null) { dirty.current = false; return; }
    const at = edits.current;
    setStatus('Saving…');
    try {
      await saveRef.current(d);
      if (edits.current === at) dirty.current = false;
      setStatus('Saved');
    } catch (e) {
      console.error('auto-save failed:', e);
      // Left dirty on purpose: a later flush is the edit's last chance.
      setStatus('Save failed');
    }
  }
  const writeRef = useRef(write);
  writeRef.current = write;

  const resolve = (next: Next<T>): T | null =>
    (typeof next === 'function' ? (next as (cur: T | null) => T | null)(latest.current) : next);

  function set(next: Next<T>) {
    latest.current = resolve(next);
    setDraft(latest.current);
  }

  // The safety net for a close this hook is not told about — a parent that
  // simply stops rendering the editor. Runs on unmount only, and does nothing
  // when the close already flushed.
  useEffect(() => () => { if (dirty.current) void writeRef.current(); }, []);

  return {
    draft,
    status,
    get dirty() { return dirty.current; },
    edit(next) {
      set(next);
      dirty.current = true;
      edits.current += 1;
      cancel();
      timer.current = setTimeout(() => { timer.current = null; void writeRef.current(); }, DELAY);
    },
    patch: set,
    replace(next, nextStatus = '') {
      cancel();
      set(next);
      dirty.current = false;
      setStatus(nextStatus);
    },
    flush: async () => { if (dirty.current) await writeRef.current(); },
  };
}

export type { SaveStatus };
