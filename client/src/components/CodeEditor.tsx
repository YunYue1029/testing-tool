import React, { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder as placeholderExt,
} from '@codemirror/view';
import {
  bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit,
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { appHighlight, appTheme } from '../code/theme';
import { varTokens, varsFacet } from '../code/vars';
import type { Vars } from '../types.ts';

export type CodeLang = 'json' | 'javascript' | 'text';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  lang?: CodeLang;
  // The active environment, for the {{var}} pills. Left out where there is no
  // environment to check against, and a token is then just a token.
  vars?: Vars;
  placeholder?: string;
  className?: string;
}

function langExt(lang: CodeLang) {
  if (lang === 'json') return json();
  if (lang === 'javascript') return javascript();
  return [];
}

// A body or a script to write. Enter keeps the indent, Tab is two spaces, a
// bracket closes itself, and {{var}} tokens are painted as they are in any
// other field.
export default function CodeEditor({
  value, onChange, lang = 'text', vars, placeholder = '', className = '',
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langC = useRef(new Compartment());
  const varsC = useRef(new Compartment());
  const phC = useRef(new Compartment());
  // Read at the time of the edit, not the time of the mount.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          EditorView.lineWrapping,
          lineNumbers(),
          foldGutter(),
          drawSelection(),
          indentUnit.of('  '),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([
            ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap,
            indentWithTab,
          ]),
          langC.current.of(langExt(lang)),
          varsC.current.of(varsFacet.of(vars ?? null)),
          ...varTokens,
          phC.current.of(placeholderExt(placeholder)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          appTheme,
          appHighlight,
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The value coming back from our own onChange already matches the document;
  // only one from elsewhere — another request opened, a Format — is written in.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: langC.current.reconfigure(langExt(lang)) });
  }, [lang]);

  useEffect(() => {
    view.current?.dispatch({ effects: phC.current.reconfigure(placeholderExt(placeholder)) });
  }, [placeholder]);

  // Callers tend to hand over a fresh object every render; only a change in
  // what it says is worth a reconfiguration.
  const varsKey = JSON.stringify(vars ?? null);
  useEffect(() => {
    view.current?.dispatch({ effects: varsC.current.reconfigure(varsFacet.of(vars ?? null)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [varsKey]);

  return <div className={`code-editor ${className}`} ref={host} />;
}
