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
  /**
   * Per-context vertical nudge (px). LOCKED at 100% UI zoom against the
   * native traffic lights (Q ruling 2026-07-16: icon center rides the
   * lights' center — conf trafficLightPosition y=25 puts that at ~19.75px
   * window-y; the pill was sitting ~3px high after titlebar churn).
   * Default +1 fits the LeftHeaderStrip (sidebar open);
   * WorkspaceHeaderStrip passes 0 so the pill lands at the SAME window-y
   * when the sidebar collapses and the toggle migrates over there.
   * Re-verify against a bitmap crop after ANY titlebar geometry change.
   */
  yNudge?: number;
  /**
   * Optional hover handlers — used by WorkspaceHeaderStrip when sidebar is
   * collapsed to drop the hover-preview overlay from the toggle pill itself
   * (Claude-style). LeftHeaderStrip doesn't pass these — its pill only
   * toggles. 2026-05-27.
   */
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}

export function SidebarTogglePill({ sidebarVisible = true, onClick, yNudge = 1, onHoverEnter, onHoverLeave }: SidebarTogglePillProps) {
  const active = sidebarVisible;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      aria-label="Toggle sidebar"
      title="Toggle sidebar (⌘B)"
      data-no-drag
      initial={false}
      animate="rest"
      whileHover="hover"
      // FLAT motion — bg + color crossfade only, no scale, no boxy active
      // state. The toggle looks identical regardless of sidebar-open vs
      // sidebar-closed; the sidebar's presence/absence IS the indicator.
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
        // Locked vertical nudge — see the yNudge prop doc: centers the pill
        // on the native traffic lights at 100% zoom (Q ruling 2026-07-16).
        marginTop: yNudge,
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      <IconPanelLeft size={14} />
    </motion.button>
  );
}
