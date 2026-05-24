'use client';

/**
 * SidebarTogglePill — icon-only sibling of the HeaderPill in
 * WorkspaceHeaderStrip. Same pill language as the Orchestrator/Chat/Terminal
 * tabs next to it. Used by LeftHeaderStrip (sidebar visible) AND
 * WorkspaceHeaderStrip (sidebar collapsed) so the look stays consistent
 * across both states.
 *
 * Style mirrors HeaderPill: 26px tall, 7px radius, transparent → hover (var
 * --t-hover) → active (var --t-input-bg) — no chrome-btn chunky box. Motion
 * variants match the prior TitleBarButton feel — animated bg/color
 * crossfade on hover + active toggles.
 */

import { motion } from 'framer-motion';
import { IconPanelLeft } from '../title-bar/icons';

interface SidebarTogglePillProps {
  sidebarVisible?: boolean;
  onClick?: () => void;
}

export function SidebarTogglePill({ sidebarVisible = true, onClick }: SidebarTogglePillProps) {
  const active = sidebarVisible;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label="Toggle sidebar"
      title="Toggle sidebar (⌘B)"
      data-no-drag
      initial={false}
      animate={active ? 'active' : 'rest'}
      whileHover="hover"
      whileTap="tap"
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
          color: 'var(--t-text)',
        },
        tap: {
          scale: 0.94,
        },
      }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      style={{
        // Geometry matches HeaderPill — same height + radius, with padding
        // tightened from 10 to 7 since there's no label, only the icon.
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 26,
        minWidth: 26,
        paddingLeft: 7,
        paddingRight: 7,
        borderWidth: 0,
        borderRadius: 7,
        cursor: 'pointer',
        flexShrink: 0,
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      <IconPanelLeft size={14} />
    </motion.button>
  );
}
