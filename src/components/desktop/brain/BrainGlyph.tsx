import type { CSSProperties } from 'react';

/** Two folded hemispheres share a quiet central connection. */
export function BrainGlyph({ size = 18, style }: { size?: number; style?: CSSProperties }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0, ...style }}>
    <path d="M12 6.4C12 3.2 8.2 2.8 6.8 5.2c-2.8-.1-4.2 2.6-3 4.7-2.2 1.8-1.8 5 .7 6.1-.3 3.2 3 5.2 5.4 3.5 1 .1 2.1-.8 2.1-2.4V6.4ZM12 6.4c0-3.2 3.8-3.6 5.2-1.2 2.8-.1 4.2 2.6 3 4.7 2.2 1.8 1.8 5-.7 6.1.3 3.2-3 5.2-5.4 3.5-1 .1-2.1-.8-2.1-2.4" />
    <path d="M6.8 5.2v2.1l2 1.1M3.8 9.9h2.4l1.3 1.6M4.5 16h2.2l1.4-2M9.9 19.5v-2.4M17.2 5.2v2.1l-2 1.1M20.2 9.9h-2.4l-1.3 1.6M19.5 16h-2.2l-1.4-2M14.1 19.5v-2.4" />
  </svg>;
}
