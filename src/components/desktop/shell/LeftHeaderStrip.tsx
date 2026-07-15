'use client';

/**
 * LeftHeaderStrip — header strip for the left (nav / AgentPanel) column.
 * Hosts the macOS traffic-light inset and the sidebar toggle. Part of epic #1089.
 */

import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { SidebarTogglePill } from './SidebarTogglePill';

interface LeftHeaderStripProps {
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  /**
   * Forwarded to SidebarTogglePill so callers can compensate when the
   * containing card's paddingTop changes. Default -2 matches the original
   * 5px paddingTop card. The production dashboard now passes -6 because the
   * card's paddingTop was bumped from 5 → 9 for outer breathing room
   * (2026-05-27) and we want the pill to stay at the same window-y as the
   * WorkspaceHeaderStrip pill when the sidebar collapses.
   */
  togglePillYNudge?: number;
}

export function LeftHeaderStrip({ sidebarVisible = true, onToggleSidebar, togglePillYNudge }: LeftHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      // Strip height 32 — the toggle pill centers at ~y=20. The traffic
      // lights center on the same line (trafficLightPosition y=15 → 12px
      // buttons centered at 21; was y=22/center 28, which sat 7px below the
      // toggle — the 2026-07-15 stoplight alignment pass).
      height={32}
      left={
        <>
          {/* Spacer for the macOS traffic lights (close / minimize / maximize).
              Lights drawn by the OS at window-x ~14–68 (post trafficLightPosition
              shift). With the panel card's 5px paddingLeft + the strip's 8px
              paddingLeft, the strip content starts at window-x = 13. Spacer
              clears the lights and leaves the toggle pill ~10px right of the
              green light, matching Claude's tight cluster. Sized in SCREEN
              pixels (× --zoom-inverse): the lights are native and ignore CSS
              zoom, so a fixed 64px shrank at 80% zoom and the toggle
              overlapped the green light (2026-07-15). */}
          <div style={{ width: 'calc(64px * var(--zoom-inverse, 1))', flexShrink: 0 }} />
          <SidebarTogglePill
            sidebarVisible={sidebarVisible}
            onClick={onToggleSidebar}
            yNudge={togglePillYNudge}
          />
        </>
      }
    />
  );
}
