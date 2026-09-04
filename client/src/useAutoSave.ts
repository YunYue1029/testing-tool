import { useEffect, useRef, useState } from 'react';

// The delay the request panel has always used: long enough that a burst of
// typing is one write, short enough that closing a dialog right after a
// keystroke is not a race.
const DELAY = 600;

type SaveStatus = '' | 'Saving…' | 'Saved' | 'Save failed';

interface AutoSave {
  status: SaveStatus;
  // Write a pending edit now instead of in 600ms — what closing a dialog does,
  // so the last keystroke before the close still lands.
  flush: () => Promise<void>;
  // Treat the next change to the draft as not an edit. For the one the saving
  // itself causes (a new record learning its id), which would otherwise come
  // straight back round as a second write of the same thing.
  skipNext: () => void;
}

// Persist `draft` a moment after it stops changing, the way an open request is
// already persisted — so an editor has nothing left to forget to save. A null
// draft is a closed editor: opening one is not an edit, and neither is the
// first render of an editor that mounts already open.
//
// Nothing here can lose the last edit: a pending write is flushed on close and
// again when the editor unmounts, whichever comes first.
export default function useAutoSave<T>(
  draft: T | null,
  save: (draft: T) => Promise<unknown> | unknown,
): AutoSave {
  const [status, setStatus] = useState<SaveStatus>('');
  // Read at write time rather than captured, so a flush cannot write a draft
  // one keystroke out of date, or through a stale save.
  const latest = useRef(draft);
  latest.current = draft;
  const saveRef = useRef(save);
  saveRef.current = save;
  // Whether the draft holds something the server has not accepted yet.
  const dirty = useRef(false);
  // False until this editor's draft has been seen once — that first sighting is
  // the open, not a change to save.
  const opened = useRef(false);

  async function write(): Promise<void> {
    const d = latest.current;
    // The editor closed, or what was being edited is gone (a deleted
    // environment): there is nothing left that a write could be about.
    if (d == null) { dirty.current = false; return; }
    setStatus('Saving…');
    try {
      await saveRef.current(d);
      dirty.current = false;
      setStatus('Saved');
    } catch (e) {
      console.error('auto-save failed:', e);
      // Left dirty on purpose: a later flush is the edit's last chance.
      setStatus('Save failed');
    }
  }
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(() => {
    if (draft == null) { opened.current = false; setStatus(''); return undefined; }
    if (!opened.current) { opened.current = true; return undefined; }
    dirty.current = true;
    const timer = setTimeout(() => { void writeRef.current(); }, DELAY);
    return () => clearTimeout(timer);
  }, [draft]);

  // The safety net for a close this hook is not told about — a parent that
  // simply stops rendering the editor. Runs on unmount only, and does nothing
  // when the close already flushed.
  useEffect(() => () => { if (dirty.current) void writeRef.current(); }, []);

  return {
    status,
    flush: async () => { if (dirty.current) await writeRef.current(); },
    skipNext: () => { opened.current = false; },
  };
}

export type { SaveStatus };
