import { useRef } from 'react';

type Handlers = Record<string, (...args: never[]) => unknown>;

// Handlers with a fixed identity that always call the latest version handed
// in. A memoised child compares its props by identity, so the fresh closures
// a parent makes on every render would have it re-render on every keystroke
// typed anywhere near it; these do not change, and read the current closure
// only when called. Keys are fixed on the first render, like hooks.
export default function useEvents<T extends Handlers>(fns: T): T {
  const latest = useRef(fns);
  latest.current = fns;
  const stable = useRef<T | null>(null);
  if (!stable.current) {
    const out: Handlers = {};
    for (const k of Object.keys(fns)) {
      out[k] = (...args: never[]) => latest.current[k]!(...args);
    }
    stable.current = out as T;
  }
  return stable.current;
}
