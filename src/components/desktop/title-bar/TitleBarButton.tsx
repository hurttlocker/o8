'use client';

import { motion } from 'framer-motion';

// TitleBarButton — flat icon button per DESIGN.md §06.7. The "motion buttons"
// language locked 2026-05-23: bg + color crossfade only, no scale, no boxy
// active state. Pass `accent="orange"` to tint the active-state icon brand
// orange (e.g. Browser button when its panel is open).
//
// Most app-shell buttons now flow through HeaderIconPill (which is this same
// language wrapped tighter for column header strips); TitleBarButton is kept
// for the few remaining one-off chrome positions that still want a slightly
// roomier hit area.
export function TitleBarButton({
  icon,
  label,
  onClick,
  active,
  accent,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  accent?: 'orange';
  /** Tooltip override — defaults to `label`. Use to add a keybind hint. */
  title?: string;
}) {
  const activeColor = accent === 'orange'
    ? 'var(--t-brand-orange, #FF5A1F)'
    : 'var(--t-text)';
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      initial={false}
      animate={active ? 'active' : 'rest'}
      whileHover="hover"
      variants={{
        rest: {
          background: 'var(--t-pill-rest-bg, transparent)',
          color: 'var(--t-text-secondary)',
        },
        hover: {
          background: 'var(--t-hover)',
          color: 'var(--t-text)',
        },
        active: {
          background: 'var(--t-input-bg)',
          color: activeColor,
        },
      }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0,
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
