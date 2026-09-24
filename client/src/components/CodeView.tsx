import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { json } from '@codemirror/lang-json';
import { appHighlight, appTheme } from '../code/theme.ts';

interface CodeViewProps {
  value: string;
  // Coloured and foldable as JSON. Off, it is plain text: a log, an HTML page.
  json?: boolean;
  className?: string;
}

// A body to read. Folding, ⌘F inside it, and JSON colouring — none of which a
// <pre> gives a payload that came back as one line.
export default function CodeView({ value, json: isJson = false, className = '' }: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          // Not editable, but focusable, or ⌘F would have nothing to land in.
          EditorView.contentAttributes.of({ tabindex: '0' }),
          EditorView.lineWrapping,
          lineNumbers(),
          foldGutter(),
          drawSelection(),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([...searchKeymap, ...foldKeymap]),
          lang.current.of(isJson ? json() : []),
          appTheme,
          appHighlight,
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Mounted once; what changes afterwards is dispatched into it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new body replaces the old one in place. The same body rendered again is
  // left alone, folds and all.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value]);

  // The language on its own: reconfiguring it re-parses the whole document,
  // which a body that merely changed does not need.
  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(isJson ? json() : []) });
  }, [isJson]);

  return <div className={`code-view ${className}`} ref={host} />;
}
