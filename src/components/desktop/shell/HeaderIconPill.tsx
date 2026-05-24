'use client';

/**
 * HeaderIconPill — generic flat icon-only pill for use anywhere in the
 * column header strips. Mirrors SidebarTogglePill's behavior exactly:
 *
 *   - 26px tall, 26px min-wide, 7px radius
 *   - transparent at rest → var(--t-hover) on hover (flat crossfade, no scale)
 *   - rest = var(--t-text-secondary), hover = var(--t-text)
 *   - no active/boxy state — the visual state of the surrounding UI is the
 *     indicator, not the button chrome
 *   - yNudge prop tunes vertical position per parent strip context
 *
 * Replaces TitleBarButton inside column header strips so the buttons read
 * as a tab-pill family with the Orchestrator/Chat tabs in the workspace
 * strip. TitleBarButton stays available for non-header chrome.
 */

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

interface HeaderIconPillProps {
  icon: ReactNode;
  label: string;
  title?: string;
  onClick?: () => void;
  /**
   * Per-context vertical nudge (px). -2 fits LeftHeaderStrip (32px strip,
   * paddingTop=5 card). WorkspaceHeaderStrip / PanelHeaderStrip use -3 to
   * compensate for their 36px strip starting at y=4.
   */
  yNudge?: number;
}

export function HeaderIconPill({
  icon,
  label,
  title,
  onClick,
  yNudge = -2,
}: HeaderIconPillProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      data-no-drag
      initial={false}
      animate="rest"
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
      }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      style={{
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
        marginTop: yNudge,
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      {icon}
    </motion.button>
  );
}
