'use client';

import { motion } from 'framer-motion';

// ── Inline SVG icons (Tauri webview doesn't reliably render Lucide React components) ──

// Icons in the left cluster use motion variants that propagate down from
// their parent TitleBarButton. The button declares whileHover="hover" /
// whileTap="tap" / animate="active|rest" — children with matching keys
// follow along. Pattern lifted from skiper-ui/skiper99 (animated-icons).

export const ICON_SPRING = { type: 'spring' as const, stiffness: 520, damping: 22, mass: 0.6 };

export function IconPanelLeft({ size = 16 }: { size?: number }) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
      variants={{
        rest: { rotate: 0 },
        hover: { rotate: 0 },
        tap: { rotate: 0 },
        active: { rotate: 0 },
      }}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <motion.path
        d="M9 3v18"
        variants={{
          rest: { x: 0 },
          hover: { x: -1.6 },
          tap: { x: -1.6 },
          active: { x: -1.6 },
        }}
        transition={ICON_SPRING}
      />
    </motion.svg>
  );
}

export function IconSearch({ size = 14 }: { size?: number }) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0, transformOrigin: '11px 11px' }}
      variants={{
        rest: { rotate: 0, scale: 1 },
        hover: { rotate: -10, scale: 1.08 },
        tap: { rotate: -4, scale: 0.94 },
      }}
      transition={ICON_SPRING}
    >
      <circle cx="11" cy="11" r="8" />
      <motion.path
        d="m21 21-4.3-4.3"
        variants={{
          rest: { x: 0, y: 0 },
          hover: { x: 1.2, y: 1.2 },
          tap: { x: 0.4, y: 0.4 },
        }}
        transition={ICON_SPRING}
      />
    </motion.svg>
  );
}

export function IconTerminal({ size = 16 }: { size?: number }) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <motion.polyline
        points="4 17 10 11 4 5"
        variants={{
          rest: { x: 0 },
          hover: { x: 1.6 },
          tap: { x: 1.6 },
          active: { x: 1.6 },
        }}
        transition={ICON_SPRING}
      />
      <line x1="12" x2="20" y1="19" y2="19" />
    </motion.svg>
  );
}

export function IconDelta({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5 18.5 18H5.5L12 5Z" />
      <path d="M8.5 14h7" />
    </svg>
  );
}

export function IconGitDiff({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M112,152a8,8,0,0,0-8,8v28.69L66.34,151A8,8,0,0,1,64,145.37V95a32,32,0,1,0-16,0v50.38a23.85,23.85,0,0,0,7,17L92.69,200H64a8,8,0,0,0,0,16h48a8,8,0,0,0,8-8V160A8,8,0,0,0,112,152ZM40,64A16,16,0,1,1,56,80,16,16,0,0,1,40,64Zm168,97V110.63a23.85,23.85,0,0,0-7-17L163.31,56H192a8,8,0,0,0,0-16H144a8,8,0,0,0-8,8V96a8,8,0,0,0,16,0V67.31L189.66,105a8,8,0,0,1,2.34,5.66V161a32,32,0,1,0,16,0Zm-8,47a16,16,0,1,1,16-16A16,16,0,0,1,200,208Z" />
    </svg>
  );
}

export function IconPanelRightCollapse({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M16 4v16" />
      <path d="m10 9 3 3-3 3" />
    </svg>
  );
}

export function IconColumns({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="3" width="7" height="18" rx="2" />
      <rect x="14" y="3" width="7" height="18" rx="2" />
    </svg>
  );
}
