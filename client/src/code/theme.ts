import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const mono = "'SF Mono', Menlo, Consolas, monospace";

// The editor dressed as the rest of the app: the same variables the stylesheet
// uses, read at paint time, so a change to the palette reaches here too.
export const appTheme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'transparent', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: mono, lineHeight: '1.45', overflow: 'auto' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 10px 0 6px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'transparent', color: 'var(--muted)', border: 'none', opacity: '.6',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 10px', minWidth: '28px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, .03)' },
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', padding: '0 4px' },
  '.cm-foldPlaceholder': {
    background: 'var(--bg-3)', border: '1px solid var(--border)', color: 'var(--muted)',
    margin: '0 4px', padding: '0 6px', borderRadius: '4px',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(124, 108, 255, .28)',
  },
  '.cm-selectionMatch': { backgroundColor: 'rgba(224, 182, 78, .18)' },
  '&.cm-focused .cm-matchingBracket, .cm-matchingBracket': {
    backgroundColor: 'rgba(124, 108, 255, .25)', outline: 'none',
  },
  '.cm-placeholder': { color: 'var(--muted)', opacity: '.6' },
  // The search panel, sized like the rest of the app's small controls rather
  // than the browser's defaults.
  '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '4px 8px', fontSize: '12px', fontFamily: 'inherit' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    padding: '2px 6px', fontSize: '12px', margin: '2px 4px 2px 0', borderRadius: '4px',
    fontFamily: 'inherit',
  },
  '.cm-panel.cm-search input': { background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-panel.cm-search button': { background: 'var(--bg-3)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-panel.cm-search label': { color: 'var(--muted)', marginRight: '6px' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)', right: '6px', top: '4px' },
  '.cm-searchMatch': { backgroundColor: 'rgba(224, 182, 78, .3)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(224, 182, 78, .55)' },
  '.cm-tooltip': {
    background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: '6px',
    color: 'var(--text)', boxShadow: '0 4px 16px rgba(0, 0, 0, .4)',
  },
  '.cm-tooltip.cm-var-tip': {
    display: 'flex', gap: '8px', alignItems: 'baseline', maxWidth: '440px',
    padding: '6px 10px', fontSize: '12px',
  },
  // {{var}} tokens: the same pills VarField paints under an input.
  '.cm-var': { borderRadius: '4px' },
  '.cm-var-hit': { background: 'rgba(124, 108, 255, .30)', boxShadow: '0 0 0 1px rgba(124, 108, 255, .45)' },
  '.cm-var-miss': { background: 'rgba(224, 87, 78, .25)', boxShadow: '0 0 0 1px rgba(224, 87, 78, .40)' },
}, { dark: true });

export const appHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: t.propertyName, color: '#8fb8ff' },
  { tag: t.string, color: '#b5d99c' },
  { tag: [t.number, t.bool, t.null], color: 'var(--yellow)' },
  { tag: t.keyword, color: '#c792ea' },
  { tag: t.function(t.variableName), color: '#8fb8ff' },
  { tag: t.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.bracket], color: 'var(--muted)' },
  { tag: t.operator, color: '#c792ea' },
]));
