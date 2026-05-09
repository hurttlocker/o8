'use client';

import { motion } from 'framer-motion';

// ── Icon Button ──

// TitleBarButton — flat 32×32 chip matching the right-side title bar buttons
// (BrowserHoverButton / RightPanelMorphButton). Transparent at rest, hover
// fills with --t-hover, active uses --t-panel-active. Pass `accent="orange"`
// to make the active state glow brand orange (matches the Browser button).
//
// Motion: parent declares variants (rest / hover / tap / active) and child
// motion.* SVG primitives inside `icon` follow along via framer-motion's
// variant propagation — same pattern as skiper-ui/skiper99 animated icons.
export function TitleBarButton({
  icon,
  label,
  onClick,
  active,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  accent?: 'orange';
}) {
  const activeColor = accent === 'orange'
    ? 'var(--t-brand-orange, #FF5A1F)'
    : 'var(--t-text)';
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      initial={false}
      animate={active ? 'active' : 'rest'}
      whileHover="hover"
      whileTap="tap"
      variants={{
        rest: {
          background: 'rgba(0, 0, 0, 0)',
          color: 'var(--t-text-secondary)',
          scale: 1,
        },
        hover: {
          background: 'var(--t-hover)',
          color: 'var(--t-text)',
          scale: 1,
        },
        active: {
          background: 'var(--t-panel-active, var(--t-input-bg))',
          color: activeColor,
          scale: 1,
        },
        tap: { scale: 0.92 },
      }}
      transition={{ type: 'spring', stiffness: 460, damping: 26, mass: 0.6 }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        padding: 0,
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
        flexShrink: 0,
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      {icon}
    </motion.button>
  );
}
