// Inline stroke icons drawn on a 24px grid (the design system's Icons set plus a few
// the boards use). Decorative unless a label is given.
import type { ReactElement } from "react";

const paths = {
  library: <path d="M4 5h16M4 12h16M4 19h10" />,
  graph: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="10" cy="18" r="2.5" />
      <path d="M8.3 7l7.4.6M7.2 8.2l1.8 7.4M16.4 10.2l-4.8 6" />
    </>
  ),
  health: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.4-4.4" />
    </>
  ),
  finding: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17v.01" />
    </>
  ),
  notice: (
    <>
      <path d="M12 8v5M12 16.5v.5" />
      <circle cx="12" cy="12" r="9" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  open: <path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5" />,
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  retire: (
    <>
      <rect x="4" y="5" width="16" height="4" rx="1" />
      <path d="M6 9v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9M10 13h4" />
    </>
  ),
  restore: (
    <>
      <path d="M4 12a8 8 0 1 0 2.3-5.7" />
      <path d="M4 4v4h4" />
    </>
  ),
  chevron: <path d="M7 10l5 5 5-5" />,
  back: <path d="M15 6l-6 6 6 6" />,
  forward: <path d="M9 6l6 6-6 6" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  agent: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 12h.01M15 12h.01M9.5 15.5h5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fingerprint: (
    <path d="M6.5 7.5a7 7 0 0 1 11 1.5M5 12.5a7 7 0 0 1 .4-2.4M19 12v1a10 10 0 0 1-1 4.5M9 12a3 3 0 0 1 6 0v1.5a13 13 0 0 1-1.2 5.5M12 12v1.5a10 10 0 0 1-1.5 5.3M7.5 15.5a10 10 0 0 0 .7 2.5" />
  ),
  book: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" />
    </>
  ),
  "zoom-in": (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.4-4.4M8.5 11h5M11 8.5v5" />
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.4-4.4M8.5 11h5" />
    </>
  ),
  fit: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  // A cog, not rays: rays read as a light or dark theme switch.
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M10.30 4.90L10.58 2.51L13.42 2.51L13.70 4.90A7.3 7.3 0 0 1 15.81 5.78L17.71 4.28L19.72 6.29L18.22 8.19A7.3 7.3 0 0 1 19.10 10.30L21.49 10.58L21.49 13.42L19.10 13.70A7.3 7.3 0 0 1 18.22 15.81L19.72 17.71L17.71 19.72L15.81 18.22A7.3 7.3 0 0 1 13.70 19.10L13.42 21.49L10.58 21.49L10.30 19.10A7.3 7.3 0 0 1 8.19 18.22L6.29 19.72L4.28 17.71L5.78 15.81A7.3 7.3 0 0 1 4.90 13.70L2.51 13.42L2.51 10.58L4.90 10.30A7.3 7.3 0 0 1 5.78 8.19L4.28 6.29L6.29 4.28L8.19 5.78A7.3 7.3 0 0 1 10.30 4.90Z" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5z" />,
  // A window with a side panel: shows or hides the sidebar.
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  // A wand with a sparkle at its tip: Obsidian's Animate.
  wand: (
    <>
      <path d="M4 20l9-9" />
      <path d="M16.5 3.5c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4z" />
      <path d="M7 3.5v3M5.5 5h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  link: (
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
  folder: (
    <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v4h-4" />
    </>
  ),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof paths;

export const ICON_NAMES = Object.keys(paths) as IconName[];

export interface IconProps {
  name: IconName;
  size?: 12 | 16 | 18 | 28;
  label?: string;
  className?: string;
}

export function Icon({ name, size = 16, label, className }: IconProps) {
  const sizeClass = size === 16 ? "" : ` k-icon-${size}`;
  return (
    <svg
      className={`k-icon${sizeClass}${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {paths[name]}
    </svg>
  );
}
