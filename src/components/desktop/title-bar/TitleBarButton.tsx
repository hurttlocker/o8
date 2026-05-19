'use client';

import { motion } from 'framer-motion';

// ── Icon Button ──

// TitleBarButton — flat compact chip matching the right-side title bar buttons
// (BrowserHoverButton / RightPanelMorphButton). Transparent at rest, hover
// fills with --t-hover, active uses --t-panel-active. Pass `accent="orange"`
// to make the active state glow brand orange (matches the Browser button).
//
// Motion is color/fill only. No tap-scale or lifted hover states here.
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
      variants={{
        rest: {
          background: 'rgba(0, 0, 0, 0)',
          color: 'var(--t-text-secondary)',
        },
        hover: {
          background: 'var(--t-hover)',
          color: 'var(--t-text)',
        },
        active: {
          background: 'var(--t-panel-active, var(--t-input-bg))',
          color: activeColor,
        },
      }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: 'none',
        borderRadius: 7,
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
