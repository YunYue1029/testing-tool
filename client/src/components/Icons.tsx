import React from 'react';

// Monochrome 14px icons shared across the UI. They inherit the surrounding
// text colour via currentColor, which emoji cannot do.
interface SvgProps {
  children: React.ReactNode;
  size?: number;
}

export function Svg({ children, size = 14 }: SvgProps) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >{children}</svg>
  );
}

export const IconPlus = () => <Svg><path d="M8 3.5v9M3.5 8h9" /></Svg>;
export const IconClose = () => <Svg><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" /></Svg>;
export const IconPencil = () => <Svg><path d="M10.8 2.4l2.8 2.8-7.4 7.4-3.4.6.6-3.4z" /></Svg>;
export const IconPlay = () => <Svg><path d="M4.5 3.2l8 4.8-8 4.8z" /></Svg>;
export const IconFolder = () => (
  <Svg><path d="M1.8 4.3a1 1 0 0 1 1-1h2.9l1.3 1.6h6.2a1 1 0 0 1 1 1v5.8a1 1 0 0 1-1 1h-10.4a1 1 0 0 1-1-1z" /></Svg>
);
// A collection: the box a set of requests is kept in. It stands where a folder
// icon stands in the Flows header — the container, next to the plus that makes
// the thing itself.
export const IconCollection = () => (
  <Svg>
    <path d="M1.9 3.3h12.2v2.6H1.9z" />
    <path d="M3 5.9h10v5.9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </Svg>
);
// A shell test: the prompt you would have typed the command at.
export const IconTerminal = () => (
  <Svg><path d="M3.4 4.6L6.2 8l-2.8 3.4M8.4 11.8h4.2" /></Svg>
);
export const IconImport = () => <Svg><path d="M8 2.5v7.4M4.6 6.6L8 10l3.4-3.4M2.6 13h10.8" /></Svg>;
export const IconExport = () => <Svg><path d="M8 10.4V3M4.6 5.9L8 2.5l3.4 3.4M2.6 13h10.8" /></Svg>;
export const IconCollapse = () => <Svg><path d="M2.8 3.5h10.4M2.8 12.5h10.4M5.4 9.2L8 6.6l2.6 2.6" /></Svg>;
export const IconSearch = () => (
  <Svg><circle cx="7.2" cy="7.2" r="4.4" /><path d="M10.5 10.5l3 3" /></Svg>
);
