import React from 'react';

// An explanation you ask for. Prose that only says what a field is for earns
// its place the first time and is noise every time after, so it waits behind a
// marker instead of sitting on the page. Anything that reports state — what is
// missing, what got overridden, what came back — is not this: that stays on
// the page, because it is news rather than documentation.
//
// The bubble opens on focus as well as hover, so the keyboard can reach it.
interface HelpTipProps {
  children: React.ReactNode;
  className?: string;
}

export default function HelpTip({ children, className = '' }: HelpTipProps) {
  return (
    <span className={`helptip${className ? ` ${className}` : ''}`}>
      <button type="button" className="helptip-mark" aria-label="What this is for">?</button>
      <span className="helptip-bubble" role="tooltip">{children}</span>
    </span>
  );
}
