import React, { useRef, useState } from 'react';
import { VAR_RE } from '../util';
import type { Vars } from '../types.ts';

// Input/textarea with {{var}} highlighting. The field itself keeps a
// transparent background; a mirror div behind it renders the same text
// (invisibly) and paints a pill background under each token — purple when the
// variable exists in the active environment, red when it doesn't. Hovering a
// token shows its resolved value. The mirror must copy the field's font and
// padding exactly, which is why `fieldClass` is applied to both.
type NativeFieldProps =
  React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>;

interface VarFieldProps extends Omit<NativeFieldProps, 'value' | 'onChange' | 'className'> {
  value: string;
  vars?: Vars;
  multiline?: boolean;
  fieldClass?: string;
  className?: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => void;
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
  value, vars = {}, multiline = false, fieldClass = '', className = '', onChange, ...rest
}: VarFieldProps) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
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

  // One of two intrinsic elements, chosen at run time; React cannot check the
  // props of a tag it only learns here, so the spread below goes through as-is.
  const Field = (multiline ? 'textarea' : 'input') as React.ElementType;

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
        {/* keep a trailing empty line from collapsing */}
        {multiline ? '​' : ''}
      </div>
      <Field
        ref={fieldRef}
        className={fieldClass}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => {
          onChange(e); requestAnimationFrame(syncScroll);
        }}
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
