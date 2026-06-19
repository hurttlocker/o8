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
 *   - a transparent hit-extender lifts the clickable area to ~44px tall while
 *     the visible 26px pill (locked, hurttlocker) is unchanged — Apple-HIG
 *     touch target without breaking the dense strip (#1259). It extends mostly
 *     UPWARD into the titlebar/drag region (harmless) so it never steals clicks
 *     from the content below the strip, and stays within the button's own width
 *     so adjacent pills never overlap.
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
        position: 'relative',
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
      {/* Transparent hit-extender — lifts the click target to ~44px tall
          (26 + 14 + 4) without touching the visible pill. Upward-dominant so
          it reaches into the titlebar/drag band, not the content below. */}
      <span
        aria-hidden
        style={{ position: 'absolute', top: -14, bottom: -4, left: 0, right: 0 }}
      />
      {icon}
    </motion.button>
  );
}
