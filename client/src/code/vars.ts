import { Facet, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration, EditorView, ViewPlugin, hoverTooltip,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { VAR_RE } from '../util';
import type { Vars } from '../types.ts';

// The active environment, as the editor sees it: null where the editor has no
// environment to check against (a flow step's dialog), so a token is shown as
// a token and not as missing.
export const varsFacet = Facet.define<Vars | null, Vars | null>({
  combine: (values) => (values.length ? values[0]! : null),
});

const has = (vars: Vars | null, name: string) =>
  vars != null && Object.prototype.hasOwnProperty.call(vars, name);

function decorate(view: EditorView): DecorationSet {
  const vars = view.state.facet(varsFacet);
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = new RegExp(VAR_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const miss = vars != null && !has(vars, m[1]!);
      b.add(
        from + m.index, from + m.index + m[0].length,
        Decoration.mark({ class: `cm-var ${miss ? 'cm-var-miss' : 'cm-var-hit'}` }),
      );
    }
  }
  return b.finish();
}

// Paints the pills. Recomputed when the text or the viewport moves, and when
// the environment does — that last one arrives as a reconfiguration, which
// changes the facet's value and nothing else.
const pills = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = decorate(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.startState.facet(varsFacet) !== u.state.facet(varsFacet)) {
      this.decorations = decorate(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

// Hovering a token says what it stands for right now — or that it stands for
// nothing in the active environment.
const tip = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const re = new RegExp(VAR_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (pos < from || pos > to) continue;
    const name = m[1]!;
    const vars = view.state.facet(varsFacet);
    return {
      pos: from,
      end: to,
      above: false,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-var-tip';
        const n = document.createElement('span');
        n.className = 'var-tip-name';
        n.textContent = name;
        dom.append(n);
        if (vars != null) {
          const v = document.createElement('span');
          if (has(vars, name)) {
            v.className = 'var-tip-value';
            v.textContent = String(vars[name]);
          } else {
            v.className = 'var-tip-missing';
            v.textContent = 'not defined in active environment';
          }
          dom.append(v);
        }
        return { dom };
      },
    };
  }
  return null;
});

export const varTokens = [pills, tip];
