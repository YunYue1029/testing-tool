import React, { useRef, useState } from 'react';
import { VAR_RE } from '../util';
import type { Vars } from '../types.ts';

// Input with {{var}} highlighting. The field itself keeps a transparent
// background; a mirror div behind it renders the same text (invisibly) and
// paints a pill background under each token — purple when the variable exists
// in the active environment, red when it doesn't. Hovering a token shows its
// resolved value. The mirror must copy the field's font and padding exactly,
// which is why `fieldClass` is applied to both. A body, being many lines, is
// a CodeEditor instead, which paints the same pills its own way.
type NativeFieldProps = React.InputHTMLAttributes<HTMLInputElement>;

interface VarFieldProps extends Omit<NativeFieldProps, 'value' | 'onChange' | 'className'> {
  value: string;
  vars?: Vars;
  fieldClass?: string;
  className?: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

// What the tooltip is showing, and where.
interface VarTip {
  x: number;
  y: number;
  name: string;
  defined: boolean;
  value: string | undefined;
}

export default function VarField({
  value, vars = {}, fieldClass = '', className = '', onChange, ...rest
}: VarFieldProps) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const [tip, setTip] = useState<VarTip | null>(null);

  const text = value || '';
  const parts: Array<{ text: string; name?: string }> = [];
  let last = 0;
  VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[0], name: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });

  function syncScroll() {
    const f = fieldRef.current;
    const mir = mirrorRef.current;
    if (f && mir) {
      mir.scrollTop = f.scrollTop;
      mir.scrollLeft = f.scrollLeft;
    }
  }

  // The mirror ignores the mouse entirely, so hit-test its token rects by hand.
  function onMouseMove(e: React.MouseEvent): void {
    const spans = mirrorRef.current ? mirrorRef.current.querySelectorAll('.var-tok') : [];
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        const name = (s as HTMLElement).dataset.name!;
        const defined = Object.prototype.hasOwnProperty.call(vars, name);
        setTip({ x: r.left, y: r.bottom + 6, name, defined, value: vars[name] });
        return;
      }
    }
    setTip(null);
  }

  return (
    <div className={`var-field ${className}`}>
      <div className={`var-mirror ${fieldClass}`} ref={mirrorRef} aria-hidden="true">
        {parts.map((p, i) => (p.name
          ? (
            <span
              key={i}
              className={`var-tok ${Object.prototype.hasOwnProperty.call(vars, p.name) ? 'hit' : 'miss'}`}
              data-name={p.name}
            >
              {p.text}
            </span>
          )
          : p.text))}
      </div>
      <input
        ref={fieldRef}
        className={fieldClass}
        value={value}
        onChange={(e) => { onChange(e); requestAnimationFrame(syncScroll); }}
        onScroll={syncScroll}
        onKeyUp={syncScroll}
        onClick={syncScroll}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setTip(null)}
        {...rest}
      />
      {tip && (
        <div className="var-tip" style={{ left: tip.x, top: tip.y }}>
          <span className="var-tip-name">{tip.name}</span>
          {tip.defined
            ? <span className="var-tip-value">{String(tip.value)}</span>
            : <span className="var-tip-missing">not defined in active environment</span>}
        </div>
      )}
    </div>
  );
}
