import { useRef } from 'react';
import { newId } from './util.ts';

// A key for a row that has none of its own. Kept beside the row rather than
// on it, so the stored shape stays what the server knows; a row edited into
// a new object inherits the key of the one it replaces, so React keeps the
// input you are typing in.
const keys = new WeakMap<object, string>();
function keyOf(row: object): string {
  let k = keys.get(row);
  if (!k) {
    k = newId();
    keys.set(row, k);
  }
  return k;
}

export interface RowList<T extends object, P extends object = Partial<T>> {
  // The stored rows, plus a blank one on the end to type the next into.
  shown: T[];
  untouched: (row: T) => boolean;
  keyOf: (row: T) => string;
  update: (i: number, patch: P) => void;
  // A row someone typed into, removed outright — clearing every field by
  // hand to make it blank again is not how anyone expects delete to work.
  remove: (i: number) => void;
  // A row made elsewhere (a variable offered by name), filed before the blank.
  add: (row: T) => void;
}

// The default rule: a row counts as untouched only while it still equals the
// blank template, a field it lacks counting as the template's. Every field
// of an assert row carries a default, so asking whether any field "has a
// value" can neither spot a pristine row nor keep a row whose only edit so
// far is a dropdown.
const equalsBlank = <T extends object>(blank: T) => (r: T): boolean =>
  Object.keys(blank).every((k) => {
    const want = (blank as Record<string, unknown>)[k];
    return ((r as Record<string, unknown>)[k] ?? want) === want;
  });

// Edit a list of rows with a trailing blank, so there is nothing to click to
// add one. The blank is never stored: it is the row offered for the next
// entry, and — for a list whose every field carries a default — a pristine
// row stored would fail every run. A row emptied back to blank stays on
// screen as that offer, with its key, so the row you emptied is still the
// row you are in.
export default function useRowList<T extends object, P extends object = Partial<T>>(
  rows: T[] | undefined,
  onChange: (rows: T[]) => void,
  blank: T,
  untouched: (row: T) => boolean = equalsBlank(blank),
): RowList<T, P> {
  // The blank on offer, held so it keeps its key from one render to the next.
  const spare = useRef<T | null>(null);
  const stored = rows || [];
  const last = stored[stored.length - 1];
  let shown: T[];
  // Rows saved before this hook stored their own trailing blank; one of
  // those serves until the next write drops it.
  if (last && untouched(last)) {
    shown = stored;
  } else {
    if (!spare.current) spare.current = { ...blank };
    shown = [...stored, spare.current];
  }

  // Write `next` less its trailing blank rows, which stay behind as the offer.
  function commit(next: T[]) {
    const out = next.slice();
    let offer: T | null = null;
    while (out.length && untouched(out[out.length - 1]!)) offer = out.pop()!;
    spare.current = offer;
    onChange(out);
  }

  return {
    shown,
    untouched,
    keyOf,
    update: (i, patch) => commit(shown.map((r, k) => {
      if (k !== i) return r;
      const edited = { ...r, ...patch } as T;
      keys.set(edited, keyOf(r));
      return edited;
    })),
    remove: (i) => commit(shown.filter((_, k) => k !== i)),
    add: (row) => commit([...stored.filter((r) => !untouched(r)), row]),
  };
}
